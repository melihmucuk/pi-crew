import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	skills?: string[];
	compaction?: boolean;
	systemPrompt: string;
	filePath: string;
}

export interface ParsedModel {
	provider: string;
	modelId: string;
}

export interface AgentDiscoveryWarning {
	filePath: string;
	message: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	warnings: AgentDiscoveryWarning[];
}

/**
 * Converts a comma-separated string or YAML array to string[].
 * Returns undefined for null/undefined input.
 */
export function parseCommaSeparated(value: unknown): string[] | undefined {
	if (value == null) return undefined;

	if (Array.isArray(value)) {
		const items = value.map((v) => String(v).trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}

	if (typeof value === "string") {
		const items = value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}

	return undefined;
}

/**
 * Parses "provider/model-id" format.
 * Returns null if "/" is missing.
 */
export function parseModel(value: unknown): ParsedModel | null {
	if (typeof value !== "string" || !value.includes("/")) {
		return null;
	}

	const slashIndex = value.indexOf("/");
	const provider = value.slice(0, slashIndex).trim();
	const modelId = value.slice(slashIndex + 1).trim();

	if (!provider || !modelId) return null;

	return { provider, modelId };
}

export function loadAgentFromFile(
	filePath: string,
	onWarning?: (warning: AgentDiscoveryWarning) => void,
): AgentConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		onWarning?.({
			filePath,
			message: `Ignored invalid agent definition. Frontmatter could not be parsed: ${reason}`,
		});
		console.warn(
			`[pi-crew] Ignoring agent definition "${filePath}": frontmatter could not be parsed: ${reason}`,
		);
		return null;
	}

	const name = frontmatter.name;
	const description = frontmatter.description;

	if (typeof name !== "string" || !name || typeof description !== "string" || !description) {
		return null;
	}

	if (/\s/.test(name)) {
		onWarning?.({
			filePath,
			message: `Ignored agent definition "${name}". Agent names cannot contain whitespace. Use "-" instead.`,
		});
		console.warn(
			`[pi-crew] Ignoring agent definition "${filePath}": agent name "${name}" contains whitespace. Use "-" instead.`,
		);
		return null;
	}

	const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;
	const thinking = typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined;

	if (model && !parseModel(model)) {
		console.warn(`[pi-crew] Agent "${name}": invalid model format "${model}" (expected "provider/model-id"), ignoring model field`);
	}

	const tools = parseCommaSeparated(frontmatter.tools);
	const skills = parseCommaSeparated(frontmatter.skills);

	const compaction = typeof frontmatter.compaction === "boolean" ? frontmatter.compaction : undefined;

	return {
		name,
		description,
		model,
		thinking,
		tools,
		skills,
		compaction,
		systemPrompt: body,
		filePath,
	};
}

export function discoverAgents(): AgentDiscoveryResult {
	const agentsDir = path.join(getAgentDir(), "agents");

	if (!fs.existsSync(agentsDir)) {
		return { agents: [], warnings: [] };
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return { agents: [], warnings: [] };
	}

	const agents: AgentConfig[] = [];
	const warnings: AgentDiscoveryWarning[] = [];

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(agentsDir, entry.name);
		const agent = loadAgentFromFile(filePath, (warning) => warnings.push(warning));
		if (agent) {
			agents.push(agent);
		}
	}

	return { agents, warnings };
}
