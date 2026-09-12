import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AgentCatalog,
	discoverAgents,
	type AgentCatalogSource,
	type AgentConfigFile,
	type AgentDefinitionSourceGroup,
} from "../extension/catalog.js";

function agentMd(name: string, fields: Record<string, string | number | boolean | string[]> = {}): string {
	const lines = ["---", `name: ${name}`, `description: ${name} description`];
	for (const [key, value] of Object.entries(fields)) {
		lines.push(Array.isArray(value) ? `${key}: [${value.join(", ")}]` : `${key}: ${value}`);
	}
	lines.push("---", `${name} prompt`);
	return lines.join("\n");
}

class InMemorySource implements AgentCatalogSource {
	constructor(
		private readonly groups: AgentDefinitionSourceGroup[],
		private readonly configs: AgentConfigFile[] = [],
	) {}

	loadAgentDefinitionGroups(): AgentDefinitionSourceGroup[] {
		return this.groups;
	}

	loadConfigFiles(): AgentConfigFile[] {
		return this.configs;
	}
}

function discover(groups: AgentDefinitionSourceGroup[], configs: AgentConfigFile[] = []) {
	return new AgentCatalog(new InMemorySource(groups, configs)).discover("/repo", { projectTrusted: true });
}

function warningText(result: { warnings: Array<{ message: string }> }): string {
	return result.warnings.map((warning) => warning.message).join("\n");
}

describe("catalog", () => {
	it("discovers agents by priority and warns only for duplicates within one source", () => {
		const result = discover([
			{
				agentsDir: "/repo/.pi/agents",
				files: [{ filePath: "/repo/.pi/agents/scout.md", content: agentMd("scout", { thinking: "high" }) }],
			},
			{
				agentsDir: "/home/.pi/agent/agents",
				files: [{ filePath: "/home/.pi/agent/agents/scout.md", content: agentMd("scout", { thinking: "low" }) }],
			},
			{
				agentsDir: "/pkg/agents",
				files: [
					{ filePath: "/pkg/agents/one.md", content: agentMd("reviewer") },
					{ filePath: "/pkg/agents/two.md", content: agentMd("reviewer") },
				],
			},
		]);

		assert.equal(result.agents.find((agent) => agent.name === "scout")?.filePath, "/repo/.pi/agents/scout.md");
		assert.equal(result.agents.find((agent) => agent.name === "scout")?.thinking, "high");
		assert.match(warningText(result), /Duplicate subagent name "reviewer"/);
	});

	it("applies config overrides in order and warns for unmatched or invalid fields", () => {
		const result = discover(
			[
				{
					agentsDir: "/pkg/agents",
					files: [{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { model: "provider/model" }) }],
				},
			],
			[
				{
					filePath: "/home/.pi/agent/pi-crew.json",
					content: JSON.stringify({ agents: { scout: { thinking: "low", interactive: false } } }),
				},
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({ agents: { scout: { model: "bad-model", unknown: true, thinking: "high" }, missing: {} } }),
				},
			],
		);

		assert.equal(result.agents[0]?.thinking, "high");
		assert.equal("interactive" in result.agents[0]!, false);
		assert.equal(result.agents[0]?.model, "bad-model");
		assert.equal(result.agents[0]?.parsedModel, undefined);
		assert.match(warningText(result), /unknown field "interactive"/);
		assert.match(warningText(result), /unknown field "unknown"/);
		assert.match(warningText(result), /invalid model format "bad-model"/);
		assert.match(warningText(result), /override "missing" does not match/);
	});

	it("preserves custom Pi tool names from definitions and overrides", () => {
		const result = discover(
			[
				{
					agentsDir: "/pkg/agents",
					files: [
						{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { tools: ["read", "project_search"] }) },
						{ filePath: "/pkg/agents/oracle.md", content: agentMd("oracle", { tools: ["read"] }) },
					],
				},
			],
			[
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({ agents: { oracle: { tools: ["read", "web_search", "web_fetch"] } } }),
				},
			],
		);

		assert.deepEqual(result.agents.find((agent) => agent.name === "scout")?.tools, ["read", "project_search"]);
		assert.deepEqual(result.agents.find((agent) => agent.name === "oracle")?.tools, ["read", "web_search", "web_fetch"]);
		assert.equal(result.warnings.length, 0);
	});

	it("applies +/- tool entries as a delta on the definition or built-in tool list", () => {
		const result = discover(
			[
				{
					agentsDir: "/pkg/agents",
					files: [
						{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { tools: ["read", "bash"] }) },
						{ filePath: "/pkg/agents/worker.md", content: agentMd("worker") },
					],
				},
			],
			[
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({
						agents: {
							scout: { tools: ["+web_search", "+web_fetch", "-bash", "-missing_tool"] },
							worker: { tools: ["-write", "+web_fetch"] },
						},
					}),
				},
			],
		);

		assert.deepEqual(result.agents.find((agent) => agent.name === "scout")?.tools, ["read", "web_search", "web_fetch"]);
		assert.deepEqual(result.agents.find((agent) => agent.name === "worker")?.tools, [
			"read",
			"bash",
			"powershell",
			"edit",
			"grep",
			"find",
			"ls",
			"web_fetch",
		]);
		assert.equal(result.warnings.length, 0);
	});

	it("composes tool deltas and replacements in user-then-project order", () => {
		const result = discover(
			[
				{
					agentsDir: "/pkg/agents",
					files: [
						{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { tools: ["read", "bash"] }) },
						{ filePath: "/pkg/agents/oracle.md", content: agentMd("oracle", { tools: ["read", "bash"] }) },
						{ filePath: "/pkg/agents/worker.md", content: agentMd("worker") },
					],
				},
			],
			[
				{
					filePath: "/home/.pi/agent/pi-crew.json",
					content: JSON.stringify({ agents: { scout: { tools: ["+web_search", "-bash"] }, oracle: { tools: ["read"] }, worker: { tools: ["+web_search"] } } }),
				},
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({ agents: { scout: { tools: ["-web_search", "+bash", "+web_fetch"] }, oracle: { tools: ["+web_fetch"] }, worker: { tools: [] } } }),
				},
			],
		);

		assert.deepEqual(result.agents.find((agent) => agent.name === "scout")?.tools, ["read", "bash", "web_fetch"]);
		assert.deepEqual(result.agents.find((agent) => agent.name === "oracle")?.tools, ["read", "web_fetch"]);
		assert.deepEqual(result.agents.find((agent) => agent.name === "worker")?.tools, []);
		assert.equal(result.warnings.length, 0);
	});

	it("ignores mixed tool deltas in both definitions and overrides with warnings", () => {
		const result = discover(
			[
				{
					agentsDir: "/pkg/agents",
					files: [
						{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { tools: ["read", "bash"] }) },
						{ filePath: "/pkg/agents/oracle.md", content: agentMd("oracle", { tools: ["read", "+web_search"] }) },
					],
				},
			],
			[
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({ agents: { scout: { tools: ["read", "+web_search"] } } }),
				},
			],
		);

		assert.deepEqual(result.agents.find((agent) => agent.name === "scout")?.tools, ["read", "bash"]);
		assert.equal(result.agents.find((agent) => agent.name === "oracle")?.tools, undefined);
		assert.equal(result.warnings.length, 2);
		assert.equal(warningText(result).match(/mixes "\+"\/"-" entries/g)?.length, 2);
	});

	it("applies a pure tool delta in a definition to the built-in tool set", () => {
		const result = discover([
			{
				agentsDir: "/pkg/agents",
				files: [{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { tools: ["+web_search", "-write"] }) }],
			},
		]);

		assert.deepEqual(result.agents[0]?.tools, ["read", "bash", "powershell", "edit", "grep", "find", "ls", "web_search"]);
		assert.equal(result.warnings.length, 0);
	});

	it("applies tool delta entries in written order", () => {
		const result = discover(
			[
				{
					agentsDir: "/pkg/agents",
					files: [
						{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { tools: ["read"] }) },
						{ filePath: "/pkg/agents/oracle.md", content: agentMd("oracle", { tools: ["read"] }) },
					],
				},
			],
			[
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({
						agents: {
							scout: { tools: ["+web_search", "-web_search"] },
							oracle: { tools: ["-web_search", "+web_search"] },
						},
					}),
				},
			],
		);

		assert.deepEqual(result.agents.find((agent) => agent.name === "scout")?.tools, ["read"]);
		assert.deepEqual(result.agents.find((agent) => agent.name === "oracle")?.tools, ["read", "web_search"]);
	});

	it("warns and ignores wrong-typed definition fields", () => {
		const result = discover([
			{
				agentsDir: "/pkg/agents",
				files: [{ filePath: "/pkg/agents/scout.md", content: agentMd("scout", { thinking: 3 }) }],
			},
		]);

		assert.equal(result.agents[0]?.thinking, undefined);
		assert.equal(result.warnings.length, 1);
		assert.match(warningText(result), /Subagent "scout": field "thinking" must be a string/);
	});

	it("parses definition fields and preserves explicit empty override lists through discovery", () => {
		const result = discover(
			[
				{
					agentsDir: "/pkg/agents",
					files: [
						{
							filePath: "/pkg/agents/scout.md",
							content: agentMd("scout", {
								model: "bad-model",
								thinking: "high",
								tools: ["read", "custom_tool"],
								skills: ["pi-crew"],
								compaction: false,
							}),
						},
						{ filePath: "/pkg/agents/oracle.md", content: agentMd("oracle", { thinking: "max" }) },
					],
				},
			],
			[
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({ agents: { scout: { name: "renamed", unknown: true, tools: [], skills: [] } } }),
				},
			],
		);

		const scout = result.agents.find((agent) => agent.name === "scout");
		assert.equal(result.agents.find((agent) => agent.name === "oracle")?.thinking, "max");
		assert.equal(scout?.model, "bad-model");
		assert.equal(scout?.parsedModel, undefined);
		assert.equal(scout?.thinking, "high");
		assert.deepEqual(scout?.tools, []);
		assert.deepEqual(scout?.skills, []);
		assert.equal(scout?.compaction, false);
		assert.match(warningText(result), /invalid model format "bad-model"/);
		assert.match(warningText(result), /field "name" is not overridable/);
		assert.match(warningText(result), /unknown field "unknown"/);
	});

	it("resolves widget.showToolCalls with a default and user-then-project precedence", () => {
		const config = (value: unknown) => JSON.stringify(value);
		const result = discover(
			[],
			[
				{ filePath: "/home/.pi/agent/pi-crew.json", content: config({ widget: { showToolCalls: false } }) },
				{ filePath: "/repo/.pi/pi-crew.json", content: config({ widget: { showToolCalls: true } }) },
			],
		);

		assert.equal(result.widget.showToolCalls, true);
		assert.equal(discover([]).widget.showToolCalls, true);
		assert.equal(
			discover([], [{ filePath: "/repo/.pi/pi-crew.json", content: config({ widget: { showToolCalls: false } }) }]).widget.showToolCalls,
			false,
		);
	});

	it("parses a widget-only config and ignores wrong-typed values without dropping agent settings", () => {
		const result = discover(
			[{ agentsDir: "/pkg/agents", files: [{ filePath: "/pkg/agents/scout.md", content: agentMd("scout") }] }],
			[{
				filePath: "/repo/.pi/pi-crew.json",
				content: JSON.stringify({ agents: { scout: { thinking: "high" } }, widget: { showToolCalls: "yes" } }),
			}],
		);

		assert.equal(result.agents[0]?.thinking, "high");
		assert.equal(result.widget.showToolCalls, true);
		assert.match(warningText(result), /Widget: field "showToolCalls" must be a boolean, ignoring/);

		const widgetOnly = discover([], [{
			filePath: "/repo/.pi/pi-crew.json",
			content: JSON.stringify({ agents: "not-an-object", widget: { showToolCalls: false } }),
		}]);

		assert.equal(widgetOnly.widget.showToolCalls, false);
		assert.match(warningText(widgetOnly), /Field "agents" must be a JSON object/);
	});

	it("discovers project agents through the filesystem wrapper", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-crew-agent-discovery-"));
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "local-smoke.md"), agentMd("local-smoke"));

		const result = discoverAgents(cwd, { projectTrusted: true });

		assert.ok(result.agents.some((agent) => agent.name === "local-smoke"));
	});

	it("skips project subagent resources with one warning when the project is not trusted", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-crew-untrusted-discovery-"));
		const projectAgentsDir = join(cwd, ".pi", "agents");
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(join(projectAgentsDir, "local-smoke.md"), agentMd("local-smoke"));
		writeFileSync(join(cwd, ".pi", "pi-crew.json"), JSON.stringify({ agents: { scout: { compaction: false } }, widget: { showToolCalls: false } }));

		const userDir = mkdtempSync(join(tmpdir(), "pi-crew-untrusted-user-dir-"));
		mkdirSync(join(userDir, "agents"), { recursive: true });
		writeFileSync(join(userDir, "agents", "user-smoke.md"), agentMd("user-smoke"));
		writeFileSync(join(userDir, "pi-crew.json"), JSON.stringify({ agents: { scout: { thinking: "low" } }, widget: { showToolCalls: true } }));

		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = userDir;
		let result;
		try {
			result = discoverAgents(cwd, { projectTrusted: false });
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}

		assert.equal(result.agents.some((agent) => agent.name === "local-smoke"), false);
		assert.ok(result.agents.some((agent) => agent.name === "user-smoke"));
		const scout = result.agents.find((agent) => agent.name === "scout");
		assert.ok(scout);
		assert.equal(scout.compaction, undefined);
		assert.equal(scout.thinking, "low");
		assert.equal(result.widget.showToolCalls, true);
		assert.equal(result.warnings.length, 1);
		assert.match(warningText(result), /not loaded because the project is not trusted/);
	});
});
