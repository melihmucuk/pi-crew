import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { isSupportedToolName } from "./tool-registry.js";

interface ParsedModel {
	provider: string;
	modelId: string;
}

export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	parsedModel?: ParsedModel;
	thinking?: ThinkingLevel;
	tools?: string[];
	skills?: string[];
	compaction?: boolean;
	interactive?: boolean;
	systemPrompt: string;
	filePath: string;
}

export interface AgentDiscoveryWarning {
	filePath: string;
	message: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	warnings: AgentDiscoveryWarning[];
}

const VALID_THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

function reportDiscoveryWarning(
	filePath: string,
	message: string,
	onWarning?: (warning: AgentDiscoveryWarning) => void,
): void {
	onWarning?.({ filePath, message });
	console.warn(`[pi-crew] ${message} (${filePath})`);
}

/**
 * Converts a comma-separated string or YAML array to string[].
 * Returns undefined for null/undefined input.
 */
function parseCommaSeparated(value: unknown): string[] | undefined {
	if (value == null) return undefined;

	if (Array.isArray(value)) {
		return value.map((v) => String(v).trim()).filter(Boolean);
	}

	if (typeof value === "string") {
		return value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	return undefined;
}

function parseListField(
	fieldName: "tools" | "skills",
	value: unknown,
	filePath: string,
	agentName: string,
	onWarning?: (warning: AgentDiscoveryWarning) => void,
): string[] {
	if (value == null) return [];

	const parsed = parseCommaSeparated(value);
	if (parsed !== undefined) return parsed;

	reportDiscoveryWarning(
		filePath,
		`Agent "${agentName}": invalid ${fieldName} field, expected a comma-separated string or YAML array`,
		onWarning,
	);
	return [];
}

/**
 * Parses "provider/model-id" format.
 * Returns null if "/" is missing.
 */
function parseModel(value: unknown): ParsedModel | null {
	if (typeof value !== "string" || !value.includes("/")) {
		return null;
	}

	const slashIndex = value.indexOf("/");
	const provider = value.slice(0, slashIndex).trim();
	const modelId = value.slice(slashIndex + 1).trim();

	if (!provider || !modelId) return null;

	return { provider, modelId };
}

function validateThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	if (VALID_THINKING_LEVELS.includes(value)) return value as ThinkingLevel;
	return undefined;
}

function loadAgentFromFile(
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
		reportDiscoveryWarning(filePath, `Ignored invalid agent definition. Frontmatter could not be parsed: ${reason}`, onWarning);
		return null;
	}

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;

	if (!name || !description) {
		reportDiscoveryWarning(
			filePath,
			"Ignored invalid agent definition. Required frontmatter fields \"name\" and \"description\" must be non-empty strings.",
			onWarning,
		);
		return null;
	}

	if (/\s/.test(name)) {
		reportDiscoveryWarning(filePath, `Ignored agent definition "${name}". Agent names cannot contain whitespace. Use "-" instead.`, onWarning);
		return null;
	}

	const modelRaw = typeof frontmatter.model === "string" ? frontmatter.model : undefined;
	const parsedModel = modelRaw ? parseModel(modelRaw) : undefined;

	if (modelRaw && !parsedModel) {
		reportDiscoveryWarning(filePath, `Agent "${name}": invalid model format "${modelRaw}" (expected "provider/model-id"), ignoring model field`, onWarning);
	}

	const thinkingRaw = typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined;
	const thinking = validateThinkingLevel(thinkingRaw);

	if (thinkingRaw && !thinking) {
		reportDiscoveryWarning(filePath, `Agent "${name}": invalid thinking level "${thinkingRaw}", ignoring`, onWarning);
	}

	const rawTools = "tools" in frontmatter
		? parseListField("tools", frontmatter.tools, filePath, name, onWarning)
		: undefined;
	const invalidTools = rawTools?.filter((toolName) => !isSupportedToolName(toolName)) ?? [];
	if (invalidTools.length > 0) {
		reportDiscoveryWarning(
			filePath,
			`Agent "${name}": unknown tools ${invalidTools.map((toolName) => `"${toolName}"`).join(", ")}, ignoring`,
			onWarning,
		);
	}
	const tools = rawTools?.filter(isSupportedToolName);

	const skills = "skills" in frontmatter
		? parseListField("skills", frontmatter.skills, filePath, name, onWarning)
		: undefined;

	const compaction = typeof frontmatter.compaction === "boolean" ? frontmatter.compaction : undefined;
	const interactive = typeof frontmatter.interactive === "boolean" ? frontmatter.interactive : undefined;

	return {
		name,
		description,
		model: modelRaw,
		parsedModel: parsedModel ?? undefined,
		thinking,
		tools,
		skills,
		compaction,
		interactive,
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
	const seenNames = new Map<string, string>();

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(agentsDir, entry.name);
		const agent = loadAgentFromFile(filePath, (warning) => warnings.push(warning));
		if (!agent) continue;

		const existing = seenNames.get(agent.name);
		if (existing) {
			reportDiscoveryWarning(filePath, `Duplicate agent name "${agent.name}" (already defined in ${existing}), skipping`, (warning) => warnings.push(warning));
			continue;
		}

		seenNames.set(agent.name, filePath);
		agents.push(agent);
	}

	return { agents, warnings };
}
