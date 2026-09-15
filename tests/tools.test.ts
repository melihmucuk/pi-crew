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

async function rejectsJsonError(action: () => Promise<unknown>, expected: RegExp): Promise<void> {
	await assert.rejects(action, (error: Error) => {
		const result = JSON.parse(error.message);
		assert.deepEqual(Object.keys(result), ["error"]);
		assert.match(result.error, expected);
		return true;
	});
}

const structuredTask = {
	goal: "Package behavior is understood.",
	context: ["The owner needs a focused package inspection."],
	instructions: ["Inspect the package and report relevant findings."],
};

class FakeCrew {
	active: ActiveAgentSummary[] = [];
	activeOwnerIds: string[] = [];
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

	getActiveSummariesForOwner(ownerSessionId?: string): ActiveAgentSummary[] {
		this.activeOwnerIds.push(ownerSessionId ?? "");
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

const renderTheme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as never;

function renderToolResult(tools: Map<string, any>, name: string, result: unknown, isError = false): string {
	const component = tools.get(name).renderResult(
		result,
		{ expanded: false, isPartial: false },
		renderTheme,
		{ isError },
	);
	return component.render(160).map(stripVTControlCharacters).join("\n");
}

function completedSummary(): ActiveAgentSummary {
	return {
		id: "planner-1",
		agentName: "planner",
		brief: "plan the migration\nstatus: \u001b[31mforged\u001b[0m",
		status: "completed",
		result: { outcome: "completed", report: "plan" },
		inputTokens: 1_000,
		outputTokens: 200,
		cost: 0.01,
		model: "model-x",
		modelName: undefined,
		thinking: "medium",
		toolCallCount: 0,
		toolFailureCount: 0,
		toolActivities: [],
		workedMs: 5_000,
	};
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

	it("returns discovery JSON and structured details from crew_list without reporting open work", async () => {
		const { crew, tools, ctx, sent } = setup();
		crew.active = [completedSummary()];

		const response = await execute(tools, "crew_list", {}, ctx);

		const parsed = JSON.parse(text(response)) as { agents: Array<Record<string, unknown>>; warnings: unknown[] };
		assert.deepEqual(
			parsed.agents.find((agent) => agent.name === "scout"),
			{ name: "scout", description: "scout description", model: null, thinking: null },
		);
		assert.equal(parsed.warnings.length, 0);
		assert.doesNotMatch(text(response), /planner-1/);
		assert.deepEqual(crew.activeOwnerIds, []);
		const details = response.details as { agents: Array<Record<string, unknown>>; warnings: unknown[] };
		assert.equal(details.agents[0]?.name, "scout");
		assert.equal(details.agents[0]?.description, "scout description");
		assert.equal(details.warnings.length, 0);
		assert.equal(sent.length, 0);
	});

	it("renders persisted legacy crew_list text without changing the result", () => {
		const { tools } = setup();
		const legacyText = "## Available Subagents\n\nname: scout\ndescription: scout description\n\n## Active Subagents\nNo subagents currently active.";
		const result = { content: [{ type: "text", text: legacyText }], details: {} };
		const saved = JSON.stringify(result);

		const output = renderToolResult(tools, "crew_list", result);

		assert.equal(output.split("\n").map((line) => line.trimEnd()).join("\n"), legacyText);
		assert.equal(JSON.stringify(result), saved);
	});

	it("reports discovery warnings as structured JSON and as a Markdown card", async () => {
		const { tools, ctx } = setup();
		writeFileSync(
			join(ctx.cwd, ".pi", "agents", "scout-copy.md"),
			["---", "name: scout", "description: duplicate", "---", "duplicate prompt"].join("\n"),
		);

		const response = await execute(tools, "crew_list", {}, ctx);

		const parsed = JSON.parse(text(response)) as { warnings: Array<{ message: string; file_path: string }> };
		assert.equal(parsed.warnings.length, 1);
		assert.match(parsed.warnings[0]?.message ?? "", /Duplicate subagent name "scout"/);
		assert.match(parsed.warnings[0]?.file_path ?? "", /scout.*\.md$/);

		initTheme("dark", false);
		const output = renderToolResult(tools, "crew_list", response);
		assert.match(output, /Discovery warnings/);
		assert.match(output, /Duplicate subagent name "scout"/);
	});

	it("returns the owner's open subagents as status JSON and structured details", async () => {
		const { crew, tools, ctx, sent } = setup();
		crew.active = [completedSummary()];

		const response = await execute(tools, "crew_status", {}, ctx);

		assert.deepEqual(JSON.parse(text(response)), {
			agents: [{
				id: "planner-1",
				name: "planner",
				brief: "plan the migration\nstatus: \u001b[31mforged\u001b[0m",
				status: "completed",
			}],
		});
		const details = response.details as { subagents: Array<Record<string, unknown>> };
		assert.equal(details.subagents[0]?.id, "planner-1");
		assert.equal(details.subagents[0]?.name, "planner");
		assert.equal(details.subagents[0]?.brief, "plan the migration\nstatus: \u001b[31mforged\u001b[0m");
		assert.equal(details.subagents[0]?.status, "completed");
		assert.equal(details.subagents[0]?.model, "model-x");
		assert.equal(details.subagents[0]?.workedMs, 5_000);
		assert.deepEqual(crew.activeOwnerIds, ["owner-1"]);
		assert.equal(sent.length, 0);
	});

	it("renders crew_status as sanitized text and reports an empty snapshot", async () => {
		const { crew, tools, ctx } = setup();
		initTheme("dark", false);

		const empty = await execute(tools, "crew_status", {}, ctx);
		assert.deepEqual(JSON.parse(text(empty)), { agents: [] });
		assert.equal(renderToolResult(tools, "crew_status", empty).trim(), "No open subagent sessions.");

		crew.active = [completedSummary()];
		const response = await execute(tools, "crew_status", {}, ctx);
		const output = renderToolResult(tools, "crew_status", response);

		assert.match(output, /Subagent sessions/);
		assert.match(output, /planner-1 · planner — plan the migration status: forged/);
		assert.match(output, /completed · model: model-x · worked: 5s/);
		assert.doesNotMatch(output, /\u001b\[31m/);
		assert.doesNotMatch(output, /"agents"/);
	});

	it("shows status fields literally without interpreting Markdown links", async () => {
		const { crew, tools, ctx } = setup();
		const link = "[click](https://evil.example)";
		crew.active = [{ ...completedSummary(), agentName: link, brief: link, modelName: link }];
		const response = await execute(tools, "crew_status", {}, ctx);
		const component = tools.get("crew_status").renderResult(response, {}, renderTheme, { isError: false });
		const raw = component.render(200).join("\n");
		assert.doesNotMatch(raw, /\u001b\]8;/);
		assert.equal(raw.split(link).length - 1, 3, "name, brief, and model label remain literal");
		assert.equal(JSON.parse(text(response)).agents[0].brief, link);
	});

	it("resolves a configured model's catalog name for display while model JSON keeps the id", async () => {
		const { tools, ctx } = setup({ agentModel: "provider/model-id" });
		initTheme("dark", false);

		const response = await execute(tools, "crew_list", {}, ctx);

		assert.equal(JSON.parse(text(response)).agents[0].model, "provider/model-id");
		const details = response.details as { agents: Array<Record<string, unknown>> };
		assert.equal(details.agents[0]?.modelName, "Resolved Model");
		assert.match(renderToolResult(tools, "crew_list", response), /\[provider\] Resolved Model/);
	});

	it("renders discovery names and model settings together and wraps full descriptions with aligned indentation", () => {
		const { tools } = setup();
		const description = "Investigates the requested repository scope and reports every relevant finding without cutting the description short.";
		const result = { details: {
			agents: [{ name: "scout", description, model: undefined, modelName: undefined, thinking: "high" }],
			warnings: [],
		} };
		const component = tools.get("crew_list").renderResult(result, {}, renderTheme, { isError: false });
		const lines: string[] = component.render(48).map(stripVTControlCharacters);
		assert.equal(lines[0].trim(), "Available subagents · 1");
		assert.equal(lines[1].trim(), "");
		assert.equal(lines[2].trim(), "scout · owner session model · high");
		const descriptionLines = lines.slice(3).filter((line) => line.trim());
		assert.ok(descriptionLines.length > 1);
		assert.ok(descriptionLines.every((line) => line.startsWith("  ")));
		assert.equal(descriptionLines.map((line) => line.trim()).join(" "), description);
		assert.ok(lines.every((line) => line.length <= 48));
	});

	it("registers crew_status as a snapshot query while keeping verified close guidance", () => {
		const { tools } = setup();
		const status = tools.get("crew_status");
		const done = tools.get("crew_done");

		assert.match(status.promptGuidelines.join("\n"), /one-time snapshot/);
		assert.match(status.promptGuidelines.join("\n"), /never poll it for completion/);
		assert.match(tools.get("crew_list").promptGuidelines.join("\n"), /crew_status/);
		assert.match(done.promptGuidelines.join("\n"), /Verify the delivered result/);
		assert.match(tools.get("crew_respond").parameters.properties.subagent_id.description, /crew_status/);
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
		assert.deepEqual(JSON.parse(text(spawned)), { subagent_id: "scout-1234" });
		assert.match(renderToolResult(tools, "crew_spawn", spawned), /Subagent 'scout' spawned as scout-1234/);
		assert.equal((crew.spawnCalls[0]?.[0] as { name?: string } | undefined)?.name, "scout");
		assert.equal((crew.spawnCalls[0]?.[4] as { brief?: string } | undefined)?.brief, "inspect package");

		await rejectsJsonError(
			() => execute(tools, "crew_spawn", { subagent: "scout", brief: " ", task: structuredTask }, ctx),
			/brief is required/,
		);
		await rejectsJsonError(
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
		await rejectsJsonError(
			() => execute(tools, "crew_spawn", {
				subagent: "scout",
				brief: "legacy string",
				task: "inspect package",
			}, ctx),
			/task is required and must be a structured assignment/,
		);

		await rejectsJsonError(
			() => execute(tools, "crew_spawn", {
				subagent: "scout",
				brief: "invalid goal",
				task: { ...structuredTask, goal: " " },
			}, ctx),
			/task\.goal is required/,
		);
		await rejectsJsonError(
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

		await rejectsJsonError(
			() => execute(tools, "crew_abort", { subagent_id: "a", all: true }, ctx),
			/Provide exactly one/,
		);

		crew.abortOwnedResult = { abortedIds: ["a"], missingIds: ["b"], foreignIds: ["c"] };
		const partial = await execute(tools, "crew_abort", { subagent_ids: ["a", "b", "c"] }, ctx);
		assert.equal(partial.terminate, true);
		assert.deepEqual(JSON.parse(text(partial)), { aborted_ids: ["a"], missing_ids: ["b"], foreign_ids: ["c"] });
		const display = renderToolResult(tools, "crew_abort", partial);
		assert.match(display, /Aborted 1 subagent\(s\): a/);
		assert.match(display, /Not found or already finished: b/);
		assert.match(display, /Belong to a different session: c/);

		crew.abortOwnedResult = { abortedIds: [], missingIds: ["b"], foreignIds: ["c"] };
		await assert.rejects(() => execute(tools, "crew_abort", { subagent_ids: ["b", "c"] }, ctx), (error: Error) => {
			assert.equal(JSON.parse(error.message).error, "Not found or already finished: b\nBelong to a different session: c");
			return true;
		});

		await rejectsJsonError(
			() => execute(tools, "crew_abort", { all: true }, ctx),
			/No active subagents in the current session\./,
		);
	});

	it("keeps tool errors readable in the TUI while returning JSON to the model", async () => {
		const { tools, ctx } = setup();
		await assert.rejects(() => execute(tools, "crew_abort", { all: true }, ctx), (error: Error) => {
			assert.deepEqual(JSON.parse(error.message), { error: "No active subagents in the current session." });
			const rendered = renderToolResult(tools, "crew_abort", { content: [{ type: "text", text: error.message }] }, true);
			assert.match(rendered, /No active subagents in the current session\./);
			assert.doesNotMatch(rendered, /"ok"|"error"/);
			return true;
		});
		assert.match(renderToolResult(tools, "crew_abort", { content: [{ type: "text", text: "SDK validation failed" }] }, true), /SDK validation failed/);
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
		await rejectsJsonError(
			() => execute(tools, "crew_respond", { subagent_id: "p", message: "hi" }, ctx),
			/not waiting/,
		);
		await rejectsJsonError(
			() => execute(tools, "crew_done", { subagent_id: "p" }, ctx),
			/not found/,
		);

		crew.respondError = undefined;
		crew.doneError = undefined;
		const respond = await execute(tools, "crew_respond", { subagent_id: "p", message: "hi" }, ctx);
		assert.deepEqual(JSON.parse(text(respond)), { subagent_id: "p" });
		assert.match(renderToolResult(tools, "crew_respond", respond), /Message sent to subagent p/);
		const done = await execute(tools, "crew_done", { subagent_id: "p" }, ctx);
		assert.deepEqual(JSON.parse(text(done)), { subagent_id: "p" });
		assert.match(renderToolResult(tools, "crew_done", done), /Subagent p closed/);
	});
});
