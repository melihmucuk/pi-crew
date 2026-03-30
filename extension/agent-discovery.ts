import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { type SupportedToolName, isSupportedToolName } from "./tool-registry.js";

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
	tools?: SupportedToolName[];
	skills?: string[];
	compaction?: boolean;
	interactive?: boolean;
	systemPrompt: string;
	filePath: string;
}

interface AgentConfigOverride {
	model?: string;
	parsedModel?: ParsedModel;
	thinking?: ThinkingLevel;
	tools?: SupportedToolName[];
	skills?: string[];
	compaction?: boolean;
	interactive?: boolean;
}

export interface AgentDiscoveryWarning {
	filePath: string;
	message: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	warnings: AgentDiscoveryWarning[];
}

interface ParseResult {
	agent: AgentConfig | null;
	warnings: AgentDiscoveryWarning[];
}

interface FileLoadResult {
	content: string | null;
	warnings: AgentDiscoveryWarning[];
}

interface DirectoryLoadResult {
	filePaths: string[];
	warnings: AgentDiscoveryWarning[];
}

interface ConfigParseResult {
	overrides: Record<string, AgentConfigOverride>;
	overrideSources: Record<string, string>;
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

const ALLOWED_OVERRIDE_FIELDS = new Set([
	"model",
	"thinking",
	"tools",
	"skills",
	"compaction",
	"interactive",
]);

function createDiscoveryWarning(filePath: string, message: string): AgentDiscoveryWarning {
	return { filePath, message };
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

type ParsedFieldName = "model" | "thinking" | "tools" | "skills" | "compaction" | "interactive";
type ParsedListFieldName = "tools" | "skills";
type ParsedBooleanFieldName = "compaction" | "interactive";
type WarningSubject = "subagent" | "subagent override";

type ParsedFieldWarning =
	| {
			code: "invalid-list-format";
			fieldName: ParsedListFieldName;
		}
	| {
			code: "invalid-type";
			fieldName: ParsedFieldName;
			expected: "string" | "boolean";
		}
	| {
			code: "invalid-model-format";
			model: string;
		}
	| {
			code: "invalid-thinking-level";
			thinking: string;
		}
	| {
			code: "unknown-tools";
			tools: string[];
		};

interface ParseFieldOptions {
	warnOnInvalidType: boolean;
	setValueOnInvalidType: boolean;
}

interface ParsedFieldSet {
	model?: string;
	parsedModel?: ParsedModel;
	thinking?: ThinkingLevel;
	tools?: SupportedToolName[];
	skills?: string[];
	compaction?: boolean;
	interactive?: boolean;
	warnings: ParsedFieldWarning[];
}

function formatFieldWarning(subject: WarningSubject, name: string, warning: ParsedFieldWarning): string {
	const prefix = `${subject === "subagent" ? "Subagent" : "Subagent override"} "${name}"`;

	switch (warning.code) {
		case "invalid-list-format":
			return `${prefix}: invalid ${warning.fieldName} field, expected a comma-separated string or YAML array`;
		case "invalid-type":
			return `${prefix}: field "${warning.fieldName}" must be a ${warning.expected}, ignoring`;
		case "invalid-model-format":
			return `${prefix}: invalid model format "${warning.model}" (expected "provider/model-id"), ignoring model field`;
		case "invalid-thinking-level":
			return `${prefix}: invalid thinking level "${warning.thinking}", ignoring`;
		case "unknown-tools":
			return `${prefix}: unknown tools ${warning.tools.map((toolName) => `"${toolName}"`).join(", ")}, ignoring`;
	}
}

function toDiscoveryWarnings(
	filePath: string,
	subject: WarningSubject,
	name: string,
	warnings: ParsedFieldWarning[],
): AgentDiscoveryWarning[] {
	return warnings.map((warning) => createDiscoveryWarning(filePath, formatFieldWarning(subject, name, warning)));
}

function parseListField(value: unknown, fieldName: ParsedListFieldName): { values: string[]; warnings: ParsedFieldWarning[] } {
	if (value == null) return { values: [], warnings: [] };

	const parsed = parseCommaSeparated(value);
	if (parsed !== undefined) return { values: parsed, warnings: [] };

	return {
		values: [],
		warnings: [{ code: "invalid-list-format", fieldName }],
	};
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

function parseModelField(value: unknown, options: ParseFieldOptions): Pick<ParsedFieldSet, "model" | "parsedModel" | "warnings"> {
	if (typeof value === "string") {
		const parsedModel = parseModel(value);
		if (!parsedModel) {
			return {
				...(options.setValueOnInvalidType ? { model: value } : {}),
				warnings: [{ code: "invalid-model-format", model: value }],
			};
		}

		return {
			model: value,
			parsedModel,
			warnings: [],
		};
	}

	if (value !== undefined && options.warnOnInvalidType) {
		return {
			warnings: [{ code: "invalid-type", fieldName: "model", expected: "string" }],
		};
	}

	return { warnings: [] };
}

function parseThinkingField(value: unknown, options: ParseFieldOptions): Pick<ParsedFieldSet, "thinking" | "warnings"> {
	if (typeof value === "string") {
		const thinking = validateThinkingLevel(value);
		if (!thinking) {
			return {
				warnings: [{ code: "invalid-thinking-level", thinking: value }],
			};
		}

		return { thinking, warnings: [] };
	}

	if (value !== undefined && options.warnOnInvalidType) {
		return {
			warnings: [{ code: "invalid-type", fieldName: "thinking", expected: "string" }],
		};
	}

	return { warnings: [] };
}

function parseToolsField(value: unknown, options: ParseFieldOptions): Pick<ParsedFieldSet, "tools" | "warnings"> {
	const parsedTools = parseListField(value, "tools");
	const validTools = parsedTools.values.filter(isSupportedToolName);
	const invalidTools = parsedTools.values.filter((toolName) => !isSupportedToolName(toolName));
	const warnings: ParsedFieldWarning[] = [...parsedTools.warnings];

	if (invalidTools.length > 0) {
		warnings.push({ code: "unknown-tools", tools: invalidTools });
	}

	if (invalidTools.length > 0 && validTools.length === 0 && !options.setValueOnInvalidType) {
		return { warnings };
	}

	if (parsedTools.warnings.length > 0 && !options.setValueOnInvalidType) {
		return { warnings };
	}

	return {
		tools: validTools,
		warnings,
	};
}

function parseSkillsField(value: unknown, options: ParseFieldOptions): Pick<ParsedFieldSet, "skills" | "warnings"> {
	const parsedSkills = parseListField(value, "skills");
	if (parsedSkills.warnings.length > 0 && !options.setValueOnInvalidType) {
		return { warnings: parsedSkills.warnings };
	}

	return {
		skills: parsedSkills.values,
		warnings: parsedSkills.warnings,
	};
}

function parseBooleanField(
	fieldName: ParsedBooleanFieldName,
	value: unknown,
	options: ParseFieldOptions,
): Pick<ParsedFieldSet, ParsedBooleanFieldName | "warnings"> {
	if (typeof value === "boolean") {
		return {
			[fieldName]: value,
			warnings: [],
		};
	}

	if (value !== undefined && options.warnOnInvalidType) {
		return {
			warnings: [{ code: "invalid-type", fieldName, expected: "boolean" }],
		};
	}

	return { warnings: [] };
}

function parseSharedFields(record: Record<string, unknown>, options: ParseFieldOptions): ParsedFieldSet {
	const model = parseModelField(record.model, options);
	const thinking = parseThinkingField(record.thinking, options);
	const tools = Object.prototype.hasOwnProperty.call(record, "tools")
		? parseToolsField(record.tools, options)
		: { warnings: [] };
	const skills = Object.prototype.hasOwnProperty.call(record, "skills")
		? parseSkillsField(record.skills, options)
		: { warnings: [] };
	const compaction = parseBooleanField("compaction", record.compaction, options);
	const interactive = parseBooleanField("interactive", record.interactive, options);

	return {
		...("model" in model ? { model: model.model } : {}),
		...("parsedModel" in model ? { parsedModel: model.parsedModel } : {}),
		...(thinking.thinking !== undefined ? { thinking: thinking.thinking } : {}),
		...(tools.tools !== undefined ? { tools: tools.tools } : {}),
		...(skills.skills !== undefined ? { skills: skills.skills } : {}),
		...(compaction.compaction !== undefined ? { compaction: compaction.compaction } : {}),
		...(interactive.interactive !== undefined ? { interactive: interactive.interactive } : {}),
		warnings: [
			...model.warnings,
			...thinking.warnings,
			...tools.warnings,
			...skills.warnings,
			...compaction.warnings,
			...interactive.warnings,
		],
	};
}

export function parseAgentDefinition(content: string, filePath: string): ParseResult {
	const warnings: AgentDiscoveryWarning[] = [];

	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			agent: null,
			warnings: [
				createDiscoveryWarning(
					filePath,
					`Ignored invalid subagent definition. Frontmatter could not be parsed: ${reason}`,
				),
			],
		};
	}

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;

	if (!name || !description) {
		return {
			agent: null,
			warnings: [
				createDiscoveryWarning(
					filePath,
					'Ignored invalid subagent definition. Required frontmatter fields "name" and "description" must be non-empty strings.',
				),
			],
		};
	}

	if (/\s/.test(name)) {
		return {
			agent: null,
			warnings: [
				createDiscoveryWarning(
					filePath,
					`Ignored subagent definition "${name}". Subagent names cannot contain whitespace. Use "-" instead.`,
				),
			],
		};
	}

	const parsedFields = parseSharedFields(frontmatter, {
		warnOnInvalidType: false,
		setValueOnInvalidType: true,
	});
	warnings.push(...toDiscoveryWarnings(filePath, "subagent", name, parsedFields.warnings));

	const { model, parsedModel, thinking, tools, skills, compaction, interactive } = parsedFields;

	return {
		agent: {
			name,
			description,
			model,
			parsedModel: parsedModel ?? undefined,
			thinking,
			tools,
			skills,
			compaction,
			interactive,
			systemPrompt: body,
			filePath,
		},
		warnings,
	};
}

function loadAgentFile(filePath: string): FileLoadResult {
	try {
		return {
			content: fs.readFileSync(filePath, "utf-8"),
			warnings: [],
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			content: null,
			warnings: [
				createDiscoveryWarning(
					filePath,
					`Ignored subagent definition. File could not be read: ${reason}`,
				),
			],
		};
	}
}

function loadAgentDefinitionFromFile(filePath: string): ParseResult {
	const file = loadAgentFile(filePath);
	if (!file.content) {
		return { agent: null, warnings: file.warnings };
	}

	const parsed = parseAgentDefinition(file.content, filePath);
	return {
		agent: parsed.agent,
		warnings: [...file.warnings, ...parsed.warnings],
	};
}

function loadAgentDefinitionFiles(agentsDir: string): DirectoryLoadResult {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			filePaths: [],
			warnings: [
				createDiscoveryWarning(
					agentsDir,
					`Subagent directory could not be read: ${reason}`,
				),
			],
		};
	}

	return {
		filePaths: entries
			.filter((entry) => entry.name.endsWith(".md"))
			.filter((entry) => entry.isFile() || entry.isSymbolicLink())
			.map((entry) => path.join(agentsDir, entry.name)),
		warnings: [],
	};
}

function parseOverrideFields(
	agentName: string,
	value: unknown,
	filePath: string,
): { override: AgentConfigOverride | null; warnings: AgentDiscoveryWarning[] } {
	const warnings: AgentDiscoveryWarning[] = [];

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {
			override: null,
			warnings: [
				createDiscoveryWarning(
					filePath,
					`Subagent override "${agentName}" must be a JSON object, ignoring`,
				),
			],
		};
	}

	const record = value as Record<string, unknown>;

	for (const fieldName of Object.keys(record)) {
		if (fieldName === "name" || fieldName === "description") {
			warnings.push(
				createDiscoveryWarning(
					filePath,
					`Subagent override "${agentName}": field "${fieldName}" is not overridable, ignoring`,
				),
			);
			continue;
		}

		if (!ALLOWED_OVERRIDE_FIELDS.has(fieldName)) {
			warnings.push(
				createDiscoveryWarning(
					filePath,
					`Subagent override "${agentName}": unknown field "${fieldName}", ignoring`,
				),
			);
		}
	}

	const parsedFields = parseSharedFields(record, {
		warnOnInvalidType: true,
		setValueOnInvalidType: false,
	});
	warnings.push(...toDiscoveryWarnings(filePath, "subagent override", agentName, parsedFields.warnings));

	const override: AgentConfigOverride = {};
	if (parsedFields.model !== undefined) {
		override.model = parsedFields.model;
	}
	if (parsedFields.parsedModel !== undefined) {
		override.parsedModel = parsedFields.parsedModel;
	}
	if (parsedFields.thinking !== undefined) {
		override.thinking = parsedFields.thinking;
	}
	if (parsedFields.tools !== undefined) {
		override.tools = parsedFields.tools;
	}
	if (parsedFields.skills !== undefined) {
		override.skills = parsedFields.skills;
	}
	if (parsedFields.compaction !== undefined) {
		override.compaction = parsedFields.compaction;
	}
	if (parsedFields.interactive !== undefined) {
		override.interactive = parsedFields.interactive;
	}

	return { override, warnings };
}

function parseConfigFile(content: string, filePath: string): ConfigParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			overrides: {},
			overrideSources: {},
			warnings: [
				createDiscoveryWarning(
					filePath,
					`Ignored pi-crew config. JSON could not be parsed: ${reason}`,
				),
			],
		};
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			overrides: {},
			overrideSources: {},
			warnings: [
				createDiscoveryWarning(
					filePath,
					"Ignored pi-crew config. Root value must be a JSON object.",
				),
			],
		};
	}

	const root = parsed as Record<string, unknown>;
	if (root.agents === undefined) {
		return { overrides: {}, overrideSources: {}, warnings: [] };
	}

	if (!root.agents || typeof root.agents !== "object" || Array.isArray(root.agents)) {
		return {
			overrides: {},
			overrideSources: {},
			warnings: [
				createDiscoveryWarning(
					filePath,
					'Ignored pi-crew config. Field "agents" must be a JSON object.',
				),
			],
		};
	}

	const overrides: Record<string, AgentConfigOverride> = {};
	const overrideSources: Record<string, string> = {};
	const warnings: AgentDiscoveryWarning[] = [];

	for (const [agentName, value] of Object.entries(root.agents)) {
		if (!agentName.trim()) {
			warnings.push(
				createDiscoveryWarning(
					filePath,
					"Ignored pi-crew config entry with empty subagent name.",
				),
			);
			continue;
		}

		const parsedOverride = parseOverrideFields(agentName, value, filePath);
		warnings.push(...parsedOverride.warnings);
		if (parsedOverride.override) {
			overrides[agentName] = parsedOverride.override;
			overrideSources[agentName] = filePath;
		}
	}

	return { overrides, overrideSources, warnings };
}

function loadConfigOverridesFromFile(filePath: string): ConfigParseResult {
	if (!fs.existsSync(filePath)) {
		return { overrides: {}, overrideSources: {}, warnings: [] };
	}

	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return parseConfigFile(content, filePath);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			overrides: {},
			overrideSources: {},
			warnings: [
				createDiscoveryWarning(
					filePath,
					`Ignored pi-crew config. File could not be read: ${reason}`,
				),
			],
		};
	}
}

function mergeConfigOverrides(
	base: Record<string, AgentConfigOverride>,
	override: Record<string, AgentConfigOverride>,
): Record<string, AgentConfigOverride> {
	const merged: Record<string, AgentConfigOverride> = { ...base };

	for (const [agentName, agentOverride] of Object.entries(override)) {
		merged[agentName] = {
			...(merged[agentName] ?? {}),
			...agentOverride,
		};
	}

	return merged;
}

function mergeOverrideSources(
	base: Record<string, string>,
	override: Record<string, string>,
): Record<string, string> {
	return {
		...base,
		...override,
	};
}

function loadConfigOverrides(cwd: string): ConfigParseResult {
	const globalPath = path.join(getAgentDir(), "pi-crew.json");
	const projectPath = path.join(cwd, ".pi", "pi-crew.json");

	const globalConfig = loadConfigOverridesFromFile(globalPath);
	const projectConfig = loadConfigOverridesFromFile(projectPath);

	return {
		overrides: mergeConfigOverrides(globalConfig.overrides, projectConfig.overrides),
		overrideSources: mergeOverrideSources(globalConfig.overrideSources, projectConfig.overrideSources),
		warnings: [...globalConfig.warnings, ...projectConfig.warnings],
	};
}

function applyAgentOverride(agent: AgentConfig, override: AgentConfigOverride): AgentConfig {
	return {
		...agent,
		...(override.model !== undefined ? { model: override.model, parsedModel: override.parsedModel } : {}),
		...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
		...(override.tools !== undefined ? { tools: override.tools } : {}),
		...(override.skills !== undefined ? { skills: override.skills } : {}),
		...(override.compaction !== undefined ? { compaction: override.compaction } : {}),
		...(override.interactive !== undefined ? { interactive: override.interactive } : {}),
	};
}

const bundledAgentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");

/**
 * Loads agents from a single directory into the agents list.
 * Skips agents whose name already exists in seenNames (higher-priority source wins).
 * Within the same directory, duplicate names produce a warning.
 */
function loadAgentsFromDir(
	agentsDir: string,
	seenNames: Map<string, string>,
	agents: AgentConfig[],
	warnings: AgentDiscoveryWarning[],
): void {
	if (!fs.existsSync(agentsDir)) return;

	const fileLoad = loadAgentDefinitionFiles(agentsDir);
	warnings.push(...fileLoad.warnings);

	const dirNames = new Set<string>();

	for (const filePath of fileLoad.filePaths) {
		const loaded = loadAgentDefinitionFromFile(filePath);
		warnings.push(...loaded.warnings);
		if (!loaded.agent) continue;

		const { name } = loaded.agent;

		// Higher-priority source already registered this name
		if (seenNames.has(name)) continue;

		// Duplicate within the same directory
		if (dirNames.has(name)) {
			warnings.push(
				createDiscoveryWarning(
					filePath,
					`Duplicate subagent name "${name}" in ${agentsDir}, skipping`,
				),
			);
			continue;
		}

		dirNames.add(name);
		seenNames.set(name, filePath);
		agents.push(loaded.agent);
	}
}

export function discoverAgents(cwd: string = process.cwd()): AgentDiscoveryResult {
	const agents: AgentConfig[] = [];
	const warnings: AgentDiscoveryWarning[] = [];
	const seenNames = new Map<string, string>();

	// Priority 1: project-level agents
	loadAgentsFromDir(path.join(cwd, ".pi", "agents"), seenNames, agents, warnings);

	// Priority 2: user global agents
	loadAgentsFromDir(path.join(getAgentDir(), "agents"), seenNames, agents, warnings);

	// Priority 3: bundled agents
	loadAgentsFromDir(bundledAgentsDir, seenNames, agents, warnings);

	const configOverrides = loadConfigOverrides(cwd);
	warnings.push(...configOverrides.warnings);

	const finalAgents = agents.map((agent) => {
		const override = configOverrides.overrides[agent.name];
		return override ? applyAgentOverride(agent, override) : agent;
	});

	for (const agentName of Object.keys(configOverrides.overrides)) {
		if (!seenNames.has(agentName)) {
			warnings.push(
				createDiscoveryWarning(
					configOverrides.overrideSources[agentName] ?? path.join(cwd, ".pi", "pi-crew.json"),
					`Subagent override "${agentName}" does not match any discovered subagent, ignoring`,
				),
			);
		}
	}

	return { agents: finalAgents, warnings };
}
