import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CrewRuntime,
	type ActiveRuntimeBinding,
	type SubagentState,
} from "../extension/crew.js";
import type { AgentConfig } from "../extension/catalog.js";
import { formatSubagentSessionName, type SubagentRunner, type SubagentRunnerCallbacks } from "../extension/subagent-session.js";
import type { CrewTask } from "../extension/task.js";
import type { SubagentSettlement } from "../extension/subagent-status.js";

const agentConfig: AgentConfig = {
	name: "scout",
	description: "scout description",
	systemPrompt: "scout prompt",
	filePath: "/agents/scout.md",
};

const task: CrewTask = {
	goal: "Complete the test assignment.",
	context: [],
	instructions: ["Run the test task."],
};

type SuccessfulSettlement = Extract<SubagentSettlement, { result: unknown }>;
type SubagentResult = SuccessfulSettlement["result"];
const completed = (report: string): Extract<SubagentResult, { outcome: "completed" }> => ({ outcome: "completed", report });
const needsInput = (report: string, needs: string): Extract<SubagentResult, { outcome: "needs_input" }> => ({ outcome: "needs_input", report, needs });

interface SentMessage {
	message: {
		customType?: string;
		content?: string;
		details?: unknown;
	};
	options: Record<string, unknown> | undefined;
}

class FakeRunner implements SubagentRunner {
	states: SubagentState[] = [];
	responds: Array<{ id: string; message: string }> = [];
	aborted: string[] = [];
	disposed: string[] = [];
	private callbacks: SubagentRunnerCallbacks;

	constructor(callbacks: SubagentRunnerCallbacks) {
		this.callbacks = callbacks;
	}

	start(state: SubagentState): void {
		this.states.push(state);
		this.callbacks.onSessionAttached(state, { sessionFile: `/sessions/${state.id}.jsonl` });
	}

	respond(state: SubagentState, message: string): void {
		this.responds.push({ id: state.id, message });
	}

	abort(state: SubagentState): void {
		this.aborted.push(state.id);
	}

	dispose(state: SubagentState): void {
		this.disposed.push(state.id);
	}

	usage(id: string, usage: { inputTokens: number; outputTokens: number; cost: number; model?: string }): void {
		const state = this.states.find((candidate) => candidate.id === id);
		assert.ok(state, `missing state ${id}`);
		this.callbacks.onUsage(state, usage);
	}

	startTool(id: string, toolCallId: string, name: string, target: string): void {
		const state = this.states.find((candidate) => candidate.id === id);
		assert.ok(state, `missing state ${id}`);
		this.callbacks.onToolStart(state, { id: toolCallId, name, target });
	}

	endTool(id: string, toolCallId: string, isError = false, resultSummary?: string): void {
		const state = this.states.find((candidate) => candidate.id === id);
		assert.ok(state, `missing state ${id}`);
		this.callbacks.onToolEnd(state, toolCallId, isError, resultSummary);
	}

	settle(id: string, settlement: SubagentSettlement): void {
		const state = this.states.find((candidate) => candidate.id === id);
		assert.ok(state, `missing state ${id}`);
		this.callbacks.onSettled(state, settlement);
	}
}

function setup(opts: {
	now?: () => number;
	scheduleFlush?: (callback: () => void) => void;
} = {}) {
	let runner!: FakeRunner;
	const sent: SentMessage[] = [];
	const entries: Array<{ customType: string; data: any }> = [];
	const refreshed: string[] = [];
	const crew = new CrewRuntime({
		now: opts.now,
		scheduleFlush: opts.scheduleFlush,
		createRunner: (callbacks) => {
			runner = new FakeRunner(callbacks);
			return runner;
		},
	});
	const binding: ActiveRuntimeBinding = {
		sessionId: "owner-1",
		sendMessage: ((message: SentMessage["message"], options?: Record<string, unknown>) => {
			sent.push({ message, options });
		}) as never,
		appendEntry: ((customType: string, data: any) => {
			entries.push({ customType, data });
		}) as never,
	};
	return { crew, runner, sent, entries, refreshed, binding };
}

function modelPayload(entry: SentMessage | undefined): unknown {
	assert.ok(entry?.message.content);
	return JSON.parse(entry.message.content);
}

function spawn(crew: CrewRuntime, ownerSessionId = "owner-1", config: AgentConfig = agentConfig): string {
	return crew.spawn(
		config,
		task,
		"/repo",
		ownerSessionId,
		{ model: undefined, modelRegistry: {} as never, agentDir: "/home/.pi/agent", brief: "task brief" },
		"/pkg/extension",
	);
}

describe("subagent session names", () => {
	it("formats session names from explicit brief without deriving from task body", () => {
		assert.equal(
			formatSubagentSessionName({ id: "scout-1234", agentConfig, brief: " inspect pi update impact\n" }),
			"crew: scout · inspect pi update impact",
		);
		assert.equal(formatSubagentSessionName({ id: "scout-1234", agentConfig, brief: "\t\n" }), "crew: scout · scout-1234");
	});
});

describe("CrewRuntime", () => {
	it("observes running work across owners without counting waiting agents or tool activity", () => {
		const { crew, runner } = setup();
		const first = spawn(crew);
		const counts: number[] = [];
		const unsubscribe = crew.observeRunningCount((count) => counts.push(count));
		const second = spawn(crew, "owner-2");
		runner.startTool(first, "read-1", "read", "README.md");
		runner.endTool(first, "read-1");
		runner.settle(first, { status: "completed", result: completed("Done") });
		runner.settle(second, { status: "needs_input", result: needsInput("Paused", "Which file?") });
		crew.respond(first, "Check again", "owner-1");
		crew.abort(first, { reason: "Cancelled" });
		crew.done(second, "owner-2");
		assert.deepEqual(counts, [1, 2, 1, 0, 1, 0]);
		unsubscribe();
		spawn(crew);
		assert.deepEqual(counts, [1, 2, 1, 0, 1, 0]);
	});

	it("settles every successful result with its outcome and keeps it active", () => {
		const { crew, runner, binding, sent } = setup();
		crew.activateSession(binding);

		const completedId = spawn(crew);
		const needsId = spawn(crew);
		runner.settle(completedId, { status: "completed", result: completed("result **body**") });
		runner.settle(needsId, { status: "needs_input", result: needsInput("partial report", "Choose A exactly") });

		const summaries = crew.getActiveSummariesForOwner("owner-1");
		assert.deepEqual(summaries.map(({ id, status, result }) => ({ id, status, result })), [
			{ id: completedId, status: "completed", result: completed("result **body**") },
			{ id: needsId, status: "needs_input", result: needsInput("partial report", "Choose A exactly") },
		]);
		assert.deepEqual(modelPayload(sent[0]), {
			subagent_id: completedId,
			brief: "task brief",
			result: completed("result **body**"),
		});
		assert.deepEqual(modelPayload(sent[1]), {
			subagent_id: needsId,
			brief: "task brief",
			result: needsInput("partial report", "Choose A exactly"),
		});
		assert.deepEqual(runner.disposed, []);
	});

	it("counts all tool calls while retaining only the latest ten", () => {
		const { crew, runner, binding } = setup();
		crew.activateSession(binding);
		const id = spawn(crew);

		for (let index = 1; index <= 12; index++) {
			runner.startTool(id, `tool-${index}`, index === 12 ? "bash" : "read", `target-${index}`);
		}
		runner.endTool(id, "tool-1", true);
		runner.endTool(id, "tool-11", false, "33 lines");
		runner.endTool(id, "tool-12", true);
		// Protocol mechanics count as a call but must not evict a real activity row.
		runner.startTool(id, "report", "crew_report", "completed");

		const summary = crew.getActiveSummariesForOwner("owner-1")[0];
		assert.equal(summary?.brief, "task brief");
		assert.equal(summary?.thinking, undefined);
		assert.equal(summary?.toolCallCount, 13);
		assert.equal(summary?.toolFailureCount, 2);
		assert.equal(summary?.toolActivities.length, 10);
		assert.ok(summary?.toolActivities.every((tool) => tool.name !== "crew_report"));
		assert.equal(summary?.toolActivities.at(-2)?.resultSummary, "33 lines");
		assert.deepEqual(summary?.toolActivities.slice(-2).map(({ id, name, target, status }) => ({ id, name, target, status })), [
			{ id: "tool-11", name: "read", target: "target-11", status: "done" },
			{ id: "tool-12", name: "bash", target: "target-12", status: "error" },
		]);
	});

	it("records reported usage and the model that produced it", () => {
		const { crew, runner, binding } = setup();
		crew.activateSession(binding);
		const id = spawn(crew);

		runner.usage(id, { inputTokens: 120, outputTokens: 35, cost: 0.5, model: "anthropic/claude" });
		runner.usage(id, { inputTokens: 240, outputTokens: 70, cost: 1.25 });

		const summary = crew.getActiveSummariesForOwner("owner-1")[0];
		assert.equal(summary?.inputTokens, 240);
		assert.equal(summary?.outputTokens, 70);
		assert.equal(summary?.cost, 1.25);
		assert.equal(summary?.model, "anthropic/claude");
	});

	it("counts only working time and accumulates it across response cycles", () => {
		let now = 0;
		const { crew, runner, binding } = setup({ now: () => now });
		crew.activateSession(binding);
		const id = spawn(crew);
		const worked = () => crew.getActiveSummariesForOwner("owner-1")[0]?.workedMs;

		now = 12_000;
		runner.settle(id, { status: "completed", result: completed("READY") });

		// Twenty minutes of waiting for the owner never count as working time.
		now = 1_212_000;
		assert.equal(worked(), 12_000);

		assert.deepEqual(crew.respond(id, "follow up", "owner-1"), {});
		now = 1_220_000;
		assert.equal(worked(), 20_000);

		runner.settle(id, { status: "completed", result: completed("DONE") });
		now = 99_999_999;
		assert.equal(worked(), 20_000);
	});

	it("clears the previous result on respond and requires explicit close", () => {
		const { crew, runner, binding } = setup();
		crew.activateSession(binding);
		const id = spawn(crew);

		runner.settle(id, { status: "completed", result: completed("READY") });
		assert.deepEqual(crew.respond(id, "follow up", "owner-1"), {});
		assert.deepEqual(
			crew.getActiveSummariesForOwner("owner-1").map(({ status, result }) => ({ status, result })),
			[{ status: "running", result: undefined }],
		);
		assert.deepEqual(runner.states.find((state) => state.id === id)?.lifecycle, { status: "running" });
		assert.deepEqual(runner.responds, [{ id, message: "follow up" }]);

		runner.settle(id, { status: "completed", result: completed("OK") });
		assert.deepEqual(crew.done(id, "owner-1"), {});
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1"), []);
		assert.deepEqual(runner.disposed, [id]);
		assert.deepEqual(crew.done(id, "owner-1"), { error: `No active subagent with id "${id}"` });
	});

	it("rejects respond and done for missing, foreign, and in-flight jobs", () => {
		const { crew } = setup();
		const id = spawn(crew);

		assert.deepEqual(crew.respond("missing", "x", "owner-1"), { error: 'No subagent with id "missing"' });
		assert.deepEqual(crew.respond(id, "x", "owner-2"), { error: `Subagent "${id}" belongs to a different session` });
		assert.deepEqual(crew.respond(id, "x", "owner-1"), { error: `Subagent "${id}" is not awaiting an owner action (status: running)` });
		assert.deepEqual(crew.done("missing", "owner-1"), { error: 'No active subagent with id "missing"' });
		assert.deepEqual(crew.done(id, "owner-1"), { error: `Subagent "${id}" is not awaiting an owner action (status: running)` });
	});

	it("aborts only owned abortable jobs and reports missing and foreign ids", () => {
		const { crew, runner } = setup();
		const owned = spawn(crew, "owner-1");
		const foreign = spawn(crew, "owner-2");

		const result = crew.abortOwned([owned, foreign, "missing"], "owner-1", { reason: "Aborted by tool request" });

		assert.deepEqual(result, {
			abortedIds: [owned],
			missingIds: ["missing"],
			foreignIds: [foreign],
		});
		assert.deepEqual(runner.aborted, [owned]);
		assert.deepEqual(runner.disposed, [owned]);
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1"), []);
		assert.equal(crew.getActiveSummariesForOwner("owner-2")[0]?.id, foreign);
	});

	it("queues inactive owner results and flushes them after session activation", () => {
		let flush: (() => void) | undefined;
		const { crew, runner, binding, sent } = setup({
			scheduleFlush: (callback) => {
				flush = callback;
			},
		});
		const id = spawn(crew);

		runner.settle(id, { status: "completed", result: completed("queued result") });
		assert.equal(sent.length, 0);

		crew.activateSession(binding);
		assert.equal(sent.length, 0);
		flush?.();

		assert.equal(sent.length, 1);
		assert.deepEqual(modelPayload(sent[0]), {
			subagent_id: id,
			brief: "task brief",
			result: completed("queued result"),
		});
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
	});

	it("drops stale pending owner messages during delayed flush", () => {
		let now = 0;
		let flush: (() => void) | undefined;
		const { crew, runner, binding, sent } = setup({
			now: () => now,
			scheduleFlush: (callback) => {
				flush = callback;
			},
		});
		const id = spawn(crew);

		runner.settle(id, { status: "completed", result: completed("stale") });
		now = 86_400_001;
		crew.activateSession(binding);
		flush?.();

		assert.equal(sent.length, 0);
	});

	it("triggers an owner turn for every delivered result", () => {
		const { crew, runner, binding, sent } = setup();
		crew.activateSession(binding);
		const first = spawn(crew);
		const second = spawn(crew);

		runner.settle(first, { status: "completed", result: completed("first done") });
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer", triggerTurn: true });

		runner.settle(second, { status: "completed", result: completed("second done") });
		assert.deepEqual(sent[1]?.options, { deliverAs: "steer", triggerTurn: true });

		const needs = spawn(crew);
		runner.settle(needs, { status: "needs_input", result: needsInput("blocked", "Choose") });
		assert.deepEqual(sent[2]?.options, { deliverAs: "steer", triggerTurn: true });
	});

	it("disposes terminal error results while delivering them in order", () => {
		const { crew, runner, binding, sent, entries } = setup();
		crew.activateSession(binding);
		const errored = spawn(crew);
		const aborted = spawn(crew);

		runner.settle(errored, { status: "error", error: "contract failed" });
		assert.equal(crew.abort(aborted, { reason: "stop" }), true);

		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1"), []);
		assert.deepEqual(runner.disposed, [errored, aborted]);
		assert.deepEqual(sent.map((entry) => entry.options), [
			{ deliverAs: "steer", triggerTurn: true },
		]);
		assert.deepEqual(modelPayload(sent[0]), {
			subagent_id: errored,
			brief: "task brief",
			status: "error",
			error: "contract failed",
		});
		// The owner already knows about its own abort, so it never reaches model context.
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.customType, "crew-abort");
		assert.deepEqual(
			(({ agentId, agentName, brief, error }) => ({ agentId, agentName, brief, error }))(entries[0]!.data),
			{ agentId: aborted, agentName: "scout", brief: "task brief", error: "stop" },
		);
	});

	it("queues aborts for an inactive owner and records them as entries on flush", () => {
		let flush: (() => void) | undefined;
		const { crew, binding, sent, entries } = setup({
			scheduleFlush: (callback) => { flush = callback; },
		});
		const id = spawn(crew);

		assert.equal(crew.abort(id, { reason: "stop" }), true);
		assert.equal(entries.length, 0);

		crew.activateSession(binding);
		assert.equal(entries.length, 0);
		flush?.();

		assert.equal(sent.length, 0);
		assert.deepEqual(entries.map((entry) => entry.customType), ["crew-abort"]);
		assert.equal(entries[0]?.data.agentId, id);
		assert.equal(entries[0]?.data.error, "stop");
	});

	it("re-parents a forked session's live subagents and queued results to the new owner", () => {
		let flush: (() => void) | undefined;
		const { crew, runner, binding, sent } = setup({
			scheduleFlush: (callback) => { flush = callback; },
		});
		crew.activateSession({ ...binding, sessionFile: "/sessions/owner-1.jsonl" });
		const waiting = spawn(crew);
		const running = spawn(crew);
		crew.deactivateSession("owner-1");
		runner.settle(waiting, { status: "needs_input", result: needsInput("blocked", "Choose") });

		const adopted = crew.adoptSession("/sessions/owner-1.jsonl", "owner-2");

		assert.deepEqual(adopted, [waiting, running]);
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1"), []);
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-2").map((summary) => summary.id), [waiting, running]);

		crew.activateSession({ ...binding, sessionId: "owner-2", sessionFile: "/sessions/owner-2.jsonl" });
		flush?.();

		assert.equal(sent.length, 1);
		assert.deepEqual(modelPayload(sent[0]), {
			subagent_id: waiting,
			brief: "task brief",
			result: needsInput("blocked", "Choose"),
		});
	});

	it("adopts nothing for an unknown previous session file", () => {
		const { crew, runner, binding, sent } = setup({ scheduleFlush: () => {} });
		crew.activateSession({ ...binding, sessionFile: "/sessions/owner-1.jsonl" });
		const id = spawn(crew);
		crew.deactivateSession("owner-1");
		runner.settle(id, { status: "needs_input", result: needsInput("blocked", "Choose") });

		assert.deepEqual(crew.adoptSession("/sessions/unknown.jsonl", "owner-2"), []);

		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1").map((summary) => summary.id), [id]);
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-2"), []);
		assert.equal(sent.length, 0);
	});
});
