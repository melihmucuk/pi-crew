import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerCrewTools } from "../extension/tools.js";
import type { AbortOwnedResult, ActiveAgentSummary } from "../extension/crew.js";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	assert.equal(result.content[0]?.type, "text");
	return result.content[0]?.text ?? "";
}

const structuredTask = {
	goal: "Package behavior is understood.",
	context: ["The owner needs a focused package inspection."],
	instructions: ["Inspect the package and report relevant findings."],
};

class FakeCrew {
	active: ActiveAgentSummary[] = [];
	spawnCalls: unknown[][] = [];
	abortAllOwnedResult: string[] = [];
	abortOwnedResult: AbortOwnedResult = { abortedIds: [], missingIds: [], foreignIds: [] };
	respondError: string | undefined;
	doneError: string | undefined;

	spawn(...args: unknown[]): string {
		this.spawnCalls.push(args);
		return "scout-1234";
	}

	abortAllOwned(): string[] {
		return this.abortAllOwnedResult;
	}

	abortOwned(): AbortOwnedResult {
		return this.abortOwnedResult;
	}

	respond(): { error?: string } {
		return { error: this.respondError };
	}

	done(): { error?: string } {
		return { error: this.doneError };
	}

	getActiveSummariesForOwner(): ActiveAgentSummary[] {
		return this.active;
	}
}

function repoWithAgent(name = "scout"): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-crew-tools-"));
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, `${name}.md`), ["---", `name: ${name}`, `description: ${name} description`, "---", `${name} prompt`].join("\n"));
	return cwd;
}

function setup() {
	const crew = new FakeCrew();
	const tools = new Map<string, any>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	registerCrewTools(pi as never, crew as never, "/pkg/extension");
	const ctx = {
		cwd: repoWithAgent(),
		hasUI: false,
		isIdle: () => false,
		model: undefined,
		modelRegistry: {} as never,
		sessionManager: {
			getSessionId: () => "owner-1",
			getSessionFile: () => "/sessions/parent.jsonl",
		},
		ui: { notify() {} },
	};
	return { crew, tools, ctx, sent };
}

async function execute(tools: Map<string, any>, name: string, params: object, ctx: unknown) {
	return tools.get(name).execute("call-1", params, undefined, undefined, ctx);
}

describe("tools", () => {
	it("lists available and active subagents and warns when active jobs exist", async () => {
		const { crew, tools, ctx, sent } = setup();
		crew.active = [{ id: "planner-1", agentName: "planner", status: "waiting", inputTokens: 1_000, outputTokens: 200, cost: 0.01, model: "model-x", thinking: "medium", toolCallCount: 0, toolFailureCount: 0, toolActivities: [], startedAt: 0 }];

		const response = await execute(tools, "crew_list", {}, ctx);
		await Promise.resolve();

		assert.match(text(response), /name: scout/);
		assert.match(text(response), /model: owner session model/);
		assert.match(text(response), /id: planner-1/);
		assert.match(text(response), /status: ⏳ waiting/);
		assert.match(text(response), /model: model-x/);
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
		assert.match(String((sent[0]?.message as { content?: unknown } | undefined)?.content), /Do not poll crew_list/);
	});

	it("registers crew_spawn with closed, grammar-compatible schemas without strict constrained sampling", () => {
		const { tools } = setup();
		const spawn = tools.get("crew_spawn");
		const task = spawn.parameters.properties.task;

		assert.equal(spawn.constrainedSampling, undefined);
		assert.equal(spawn.parameters.additionalProperties, false);
		assert.equal(task.additionalProperties, false);
		assert.equal(task.properties.goal.pattern, undefined);
		assert.equal(task.properties.goal.minLength, 1);
		assert.equal(task.properties.context.items.pattern, undefined);
		assert.equal(task.properties.context.items.minLength, 1);
		assert.equal(task.properties.instructions.items.pattern, undefined);
		assert.equal(task.properties.instructions.items.minLength, 1);
		assert.equal(tools.get("crew_abort").constrainedSampling, undefined);
	});

	it("spawns known agents and reports unknown names", async () => {
		const { crew, tools, ctx } = setup();

		const spawned = await execute(tools, "crew_spawn", { subagent: "scout", brief: "inspect package", task: structuredTask }, ctx);
		assert.match(text(spawned), /Subagent 'scout' spawned as scout-1234/);
		assert.deepEqual(spawned.details, { id: "scout-1234" });
		assert.equal((crew.spawnCalls[0]?.[0] as { name?: string } | undefined)?.name, "scout");
		assert.equal((crew.spawnCalls[0]?.[4] as { brief?: string } | undefined)?.brief, "inspect package");

		await assert.rejects(
			() => execute(tools, "crew_spawn", { subagent: "scout", brief: " ", task: structuredTask }, ctx),
			/brief is required/,
		);
		await assert.rejects(
			() => execute(tools, "crew_spawn", { subagent: "missing", brief: "missing task", task: structuredTask }, ctx),
			/Unknown subagent: "missing"\. Available:/,
		);
	});

	it("shows the full structured task only when the spawn call is expanded", () => {
		const { tools } = setup();
		const renderCall = tools.get("crew_spawn").renderCall;
		const args = {
			subagent: "scout",
			brief: "inspect package",
			task: structuredTask,
		};
		const theme = {
			fg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		};
		const render = (expanded: boolean) => {
			const component = renderCall(args, theme, { expanded, argsComplete: true });
			return component.render(120).map(stripVTControlCharacters).join("\n");
		};

		const collapsed = render(false);
		assert.match(collapsed, /Package behavior is understood\./);
		assert.doesNotMatch(collapsed, /The owner needs a focused package inspection\./);

		initTheme("dark", false);
		const expanded = render(true);
		assert.match(expanded, /Goal/);
		assert.match(expanded, /Context/);
		assert.match(expanded, /The owner needs a focused package inspection\./);
		assert.match(expanded, /Instructions/);
		assert.match(expanded, /Inspect the package and report relevant findings\./);
	});

	it("requires valid structured spawn tasks", async () => {
		const { tools, ctx } = setup();
		await assert.rejects(
			() => execute(tools, "crew_spawn", {
				subagent: "scout",
				brief: "legacy string",
				task: "inspect package",
			}, ctx),
			/task is required and must be a structured assignment/,
		);

		await assert.rejects(
			() => execute(tools, "crew_spawn", {
				subagent: "scout",
				brief: "invalid goal",
				task: { ...structuredTask, goal: " " },
			}, ctx),
			/task\.goal is required/,
		);
		await assert.rejects(
			() => execute(tools, "crew_spawn", {
				subagent: "scout",
				brief: "invalid instructions",
				task: { ...structuredTask, instructions: [] },
			}, ctx),
			/task\.instructions must contain/,
		);
	});

	it("validates abort modes and formats partial abort results", async () => {
		const { crew, tools, ctx } = setup();

		await assert.rejects(
			() => execute(tools, "crew_abort", { subagent_id: "a", all: true }, ctx),
			/Provide exactly one/,
		);

		crew.abortOwnedResult = { abortedIds: ["a"], missingIds: ["b"], foreignIds: ["c"] };
		const partial = await execute(tools, "crew_abort", { subagent_ids: ["a", "b", "c"] }, ctx);
		assert.equal(partial.terminate, true);
		assert.match(text(partial), /Aborted 1 subagent\(s\): a/);
		assert.match(text(partial), /Not found or already finished: b/);
		assert.match(text(partial), /Belong to a different session: c/);
		assert.deepEqual(partial.details, { ids: ["a"], missing_ids: ["b"], foreign_ids: ["c"] });

		await assert.rejects(
			() => execute(tools, "crew_abort", { all: true }, ctx),
			/No active subagents in the current session\./,
		);
	});

	it("passes respond and done errors through and formats success", async () => {
		const { crew, tools, ctx } = setup();
		crew.respondError = "not waiting";
		crew.doneError = "not found";
		await assert.rejects(
			() => execute(tools, "crew_respond", { subagent_id: "p", message: "hi" }, ctx),
			/not waiting/,
		);
		await assert.rejects(
			() => execute(tools, "crew_done", { subagent_id: "p" }, ctx),
			/not found/,
		);

		crew.respondError = undefined;
		crew.doneError = undefined;
		const respond = await execute(tools, "crew_respond", { subagent_id: "p", message: "hi" }, ctx);
		assert.match(text(respond), /Message sent to subagent p/);
		assert.deepEqual(respond.details, { id: "p" });
		const done = await execute(tools, "crew_done", { subagent_id: "p" }, ctx);
		assert.match(text(done), /Subagent p closed/);
		assert.deepEqual(done.details, { id: "p" });
	});
});
