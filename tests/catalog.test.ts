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

function agentMd(name: string, fields: Record<string, string | boolean | string[]> = {}): string {
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
	return new AgentCatalog(new InMemorySource(groups, configs)).discover("/repo");
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
		assert.equal(result.agents[0]?.interactive, false);
		assert.equal(result.agents[0]?.model, "provider/model");
		assert.match(warningText(result), /unknown field "unknown"/);
		assert.match(warningText(result), /invalid model format "bad-model"/);
		assert.match(warningText(result), /override "missing" does not match/);
	});

	it("accepts the max thinking level", () => {
		const result = discover([
			{
				agentsDir: "/pkg/agents",
				files: [{ filePath: "/pkg/agents/oracle.md", content: agentMd("oracle", { thinking: "max" }) }],
			},
		]);

		assert.equal(result.agents[0]?.thinking, "max");
		assert.equal(result.warnings.length, 0);
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
								tools: ["read", "missing"],
								skills: ["pi-crew"],
								compaction: false,
								interactive: true,
							}),
						},
					],
				},
			],
			[
				{
					filePath: "/repo/.pi/pi-crew.json",
					content: JSON.stringify({ agents: { scout: { name: "renamed", unknown: true, tools: [], skills: [], interactive: "yes" } } }),
				},
			],
		);

		const scout = result.agents[0];
		assert.equal(scout?.model, "bad-model");
		assert.equal(scout?.parsedModel, undefined);
		assert.equal(scout?.thinking, "high");
		assert.deepEqual(scout?.tools, []);
		assert.deepEqual(scout?.skills, []);
		assert.equal(scout?.compaction, false);
		assert.equal(scout?.interactive, true);
		assert.match(warningText(result), /invalid model format "bad-model"/);
		assert.match(warningText(result), /unknown tools "missing"/);
		assert.match(warningText(result), /field "name" is not overridable/);
		assert.match(warningText(result), /unknown field "unknown"/);
		assert.match(warningText(result), /field "interactive" must be a boolean/);
	});

	it("discovers project agents through the filesystem wrapper", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-crew-agent-discovery-"));
		const agentsDir = join(cwd, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "local-smoke.md"), agentMd("local-smoke"));

		const result = discoverAgents(cwd);

		assert.ok(result.agents.some((agent) => agent.name === "local-smoke"));
	});
});
