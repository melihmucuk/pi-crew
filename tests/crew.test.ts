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
import type { SubagentStatus } from "../extension/ui.js";

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
	private callbacks: SubagentRunnerCallbacks;

	constructor(callbacks: SubagentRunnerCallbacks) {
		this.callbacks = callbacks;
	}

	start(state: SubagentState): void {
		state.session = { sessionFile: `/sessions/${state.id}.jsonl`, dispose() {} } as never;
		this.states.push(state);
	}

	respond(state: SubagentState, message: string): void {
		this.responds.push({ id: state.id, message });
	}

	abort(state: SubagentState): void {
		this.aborted.push(state.id);
	}

	startTool(id: string, toolCallId: string, name: string, target: string): void {
		const state = this.states.find((candidate) => candidate.id === id);
		assert.ok(state, `missing state ${id}`);
		this.callbacks.onToolStart(state, { id: toolCallId, name, target });
	}

	endTool(id: string, toolCallId: string, isError = false): void {
		const state = this.states.find((candidate) => candidate.id === id);
		assert.ok(state, `missing state ${id}`);
		this.callbacks.onToolEnd(state, toolCallId, isError);
	}

	settle(id: string, status: Exclude<SubagentStatus, "running">, outcome: { result?: string; error?: string }): void {
		const state = this.states.find((candidate) => candidate.id === id);
		assert.ok(state, `missing state ${id}`);
		this.callbacks.onSettled(state, status, outcome);
	}
}

function setup(opts: {
	isIdle?: boolean;
	now?: () => number;
	scheduleFlush?: (callback: () => void) => void;
} = {}) {
	let runner!: FakeRunner;
	const sent: SentMessage[] = [];
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
		isIdle: () => opts.isIdle ?? true,
		sendMessage: ((message: SentMessage["message"], options?: Record<string, unknown>) => {
			sent.push({ message, options });
		}) as never,
	};
	return { crew, runner, sent, refreshed, binding };
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
	it("spawns active jobs and settles non-interactive jobs with result delivery and cleanup", () => {
		const { crew, runner, binding, sent } = setup();
		crew.activateSession(binding);

		const id = spawn(crew);
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1").map((agent) => agent.id), [id]);

		runner.settle(id, "done", { result: "result body" });

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.customType, "crew-result");
		assert.match(sent[0]?.message.content ?? "", /result body/);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true });
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1"), []);
	});

	it("counts all tool calls while retaining only the latest ten", () => {
		const { crew, runner, binding } = setup();
		crew.activateSession(binding);
		const id = spawn(crew);

		for (let index = 1; index <= 12; index++) {
			runner.startTool(id, `tool-${index}`, index === 12 ? "bash" : "read", `target-${index}`);
		}
		runner.endTool(id, "tool-11");
		runner.endTool(id, "tool-12", true);

		const summary = crew.getActiveSummariesForOwner("owner-1")[0];
		assert.equal(summary?.brief, "task brief");
		assert.equal(summary?.thinking, undefined);
		assert.equal(summary?.toolCallCount, 12);
		assert.equal(summary?.toolActivities.length, 10);
		assert.deepEqual(summary?.toolActivities.slice(-2), [
			{ id: "tool-11", name: "read", target: "target-11", status: "done" },
			{ id: "tool-12", name: "bash", target: "target-12", status: "error" },
		]);
	});

	it("keeps interactive jobs waiting, accepts respond, and closes with done", () => {
		const { crew, runner, binding } = setup();
		crew.activateSession(binding);
		const id = spawn(crew, "owner-1", { ...agentConfig, interactive: true });

		runner.settle(id, "waiting", { result: "READY" });

		assert.equal(crew.getActiveSummariesForOwner("owner-1")[0]?.status, "waiting");
		assert.deepEqual(crew.respond(id, "follow up", "owner-1"), {});
		assert.equal(crew.getActiveSummariesForOwner("owner-1")[0]?.status, "running");
		assert.deepEqual(runner.responds, [{ id, message: "follow up" }]);

		runner.settle(id, "waiting", { result: "OK" });
		assert.deepEqual(crew.done(id, "owner-1"), {});
		assert.deepEqual(crew.getActiveSummariesForOwner("owner-1"), []);
		assert.deepEqual(crew.done(id, "owner-1"), { error: `No active subagent with id "${id}"` });
	});

	it("rejects respond and done for missing, foreign, and non-waiting jobs", () => {
		const { crew } = setup();
		const id = spawn(crew);

		assert.deepEqual(crew.respond("missing", "x", "owner-1"), { error: 'No subagent with id "missing"' });
		assert.deepEqual(crew.respond(id, "x", "owner-2"), { error: `Subagent "${id}" belongs to a different session` });
		assert.deepEqual(crew.respond(id, "x", "owner-1"), { error: `Subagent "${id}" is not waiting for a response (status: running)` });
		assert.deepEqual(crew.done("missing", "owner-1"), { error: 'No active subagent with id "missing"' });
		assert.deepEqual(crew.done(id, "owner-1"), { error: `Subagent "${id}" is not in waiting state` });
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

		runner.settle(id, "done", { result: "queued result" });
		assert.equal(sent.length, 0);

		crew.activateSession(binding);
		assert.equal(sent.length, 0);
		flush?.();

		assert.equal(sent.length, 1);
		assert.match(sent[0]?.message.content ?? "", /queued result/);
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

		runner.settle(id, "done", { result: "stale" });
		now = 86_400_001;
		crew.activateSession(binding);
		flush?.();

		assert.equal(sent.length, 0);
	});

	it("suppresses intermediate idle done turns and uses streaming delivery policy", () => {
		const idle = setup({ isIdle: true });
		idle.crew.activateSession(idle.binding);
		const first = spawn(idle.crew);
		const second = spawn(idle.crew);

		idle.runner.settle(first, "done", { result: "first done" });

		assert.equal(idle.sent.length, 1);
		assert.equal(idle.sent[0]?.message.customType, "crew-result");
		assert.deepEqual(idle.sent[0]?.options, { triggerTurn: false });

		idle.runner.settle(second, "done", { result: "second done" });
		assert.equal(idle.sent.length, 2);
		assert.deepEqual(idle.sent[1]?.options, { triggerTurn: true });

		const streaming = setup({ isIdle: false });
		streaming.crew.activateSession(streaming.binding);
		const id = spawn(streaming.crew);
		streaming.runner.settle(id, "done", { result: "streaming done" });
		assert.deepEqual(streaming.sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
	});

	it("triggers idle owner turns for waiting interactive subagents even when others are running", () => {
		const { crew, runner, binding, sent } = setup({ isIdle: true });
		crew.activateSession(binding);
		const interactive = spawn(crew, "owner-1", { ...agentConfig, interactive: true });
		spawn(crew);

		runner.settle(interactive, "waiting", { result: "need input" });

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.customType, "crew-result");
		assert.deepEqual(sent[0]?.options, { triggerTurn: true });
	});
});
