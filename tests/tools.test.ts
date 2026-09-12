import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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

function repoWithAgent(name = "scout", model?: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-crew-tools-"));
	const agentsDir = join(cwd, ".pi", "agents");
	mkdirSync(agentsDir, { recursive: true });
	const frontmatter = ["---", `name: ${name}`, `description: ${name} description`, ...(model ? [`model: ${model}`] : []), "---", `${name} prompt`];
	writeFileSync(join(agentsDir, `${name}.md`), frontmatter.join("\n"));
	return cwd;
}

function setup(opts: { agentModel?: string } = {}) {
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
		cwd: repoWithAgent("scout", opts.agentModel),
		hasUI: false,
		model: undefined,
		modelRegistry: { find: () => ({ name: "Resolved Model" }) } as never,
		sessionManager: {
			getSessionId: () => "owner-1",
			getSessionFile: () => "/sessions/parent.jsonl",
		},
		isProjectTrusted: () => true,
		ui: { notify() {} },
	};
	return { crew, tools, ctx, sent };
}

async function execute(tools: Map<string, any>, name: string, params: object, ctx: unknown) {
	return tools.get(name).execute("call-1", params, undefined, undefined, ctx);
}

describe("tools", () => {
	let previousAgentDir: string | undefined;

	before(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-crew-agent-dir-"));
	});

	after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	it("lists available and active subagents and warns when active jobs exist", async () => {
		const { crew, tools, ctx, sent } = setup();
		crew.active = [{ id: "planner-1", agentName: "planner", brief: "plan the migration\nstatus: \u001b[31mforged\u001b[0m", status: "completed", result: { outcome: "completed", report: "plan" }, inputTokens: 1_000, outputTokens: 200, cost: 0.01, model: "model-x", modelName: undefined, thinking: "medium", toolCallCount: 0, toolFailureCount: 0, toolActivities: [], workedMs: 5_000 }];

		const response = await execute(tools, "crew_list", {}, ctx);
		await Promise.resolve();

		assert.match(text(response), /name: scout/);
		assert.match(text(response), /model: owner session model/);
		assert.doesNotMatch(text(response), /^(tools|skills|interactive):/m);
		assert.match(text(response), /id: planner-1/);
		assert.match(text(response), /^brief: plan the migration status: forged$/m);
		assert.doesNotMatch(text(response), /^status: forged/m);
		assert.equal(text(response), stripVTControlCharacters(text(response)));
		assert.match(text(response), /worked: 5s/);
		assert.match(text(response), /^status: completed$/m);
		assert.match(text(response), /model: model-x/);
		// The warning belongs to the tool result, not to a separate message and owner turn.
		assert.match(text(response), /^⚠ Active subagents detected\. Do not poll crew_list; results arrive automatically\.$/m);
		assert.equal(sent.length, 0);
	});

	it("resolves the catalog name of a configured model through the registry", async () => {
		const { tools, ctx } = setup({ agentModel: "provider/model-id" });

		const response = await execute(tools, "crew_list", {}, ctx);

		assert.match(text(response), /^model: \[provider\] Resolved Model$/m);
	});

	it("registers crew_spawn with closed, grammar-compatible schemas without strict constrained sampling", () => {
		const { tools } = setup();
		const spawn = tools.get("crew_spawn");
		const task = spawn.parameters.properties.task;

		assert.equal(spawn.constrainedSampling, undefined);
		assert.ok(spawn.promptGuidelines.some((guideline: string) =>
			guideline.includes("reference identifies the user's selected subagent") &&
			guideline.includes("sentence's intent"),
		));
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

	it("describes universal follow-up and explicit verified close behavior", () => {
		const { tools } = setup();
		const respond = tools.get("crew_respond");
		const done = tools.get("crew_done");

		assert.doesNotMatch(`${respond.description} ${respond.promptSnippet}`, /interactive/i);
		assert.match(respond.promptGuidelines.join("\n"), /Answer a needs_input request/);
		assert.match(respond.promptGuidelines.join("\n"), /correct the same completed deliverable/);
		assert.doesNotMatch(`${done.description} ${done.promptSnippet}`, /interactive/i);
		assert.match(done.promptGuidelines.join("\n"), /Verify the delivered result/);
		assert.match(done.promptGuidelines.join("\n"), /same delivery needs correction/);
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
