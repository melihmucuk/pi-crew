import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

const PROJECT_CONFIG_DIR_NAME = piCodingAgent.CONFIG_DIR_NAME ?? ".pi";

export interface ParsedModel {
	provider: string;
	modelId: string;
}

interface AgentConfigFields {
	model?: string;
	parsedModel?: ParsedModel;
	thinking?: ThinkingLevel;
	tools?: string[];
	skills?: string[];
	compaction?: boolean;
	interactive?: boolean;
}

export interface AgentConfig extends AgentConfigFields {
	name: string;
	description: string;
	systemPrompt: string;
	filePath: string;
}

export interface AgentDiscoveryWarning {
	filePath: string;
	message: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	warnings: AgentDiscoveryWarning[];
}

export interface AgentDefinitionFile {
	filePath: string;
	content: string | null;
	warnings?: AgentDiscoveryWarning[];
}

export interface AgentDefinitionSourceGroup {
	agentsDir: string;
	files: AgentDefinitionFile[];
	warnings?: AgentDiscoveryWarning[];
}

export interface AgentConfigFile {
	filePath: string;
	content: string | null;
	warnings?: AgentDiscoveryWarning[];
}

export interface AgentCatalogSource {
	loadAgentDefinitionGroups(cwd: string): AgentDefinitionSourceGroup[];
	loadConfigFiles(cwd: string): AgentConfigFile[];
}

type AgentConfigOverride = AgentConfigFields;
type ParsedFieldName = "model" | "thinking" | "tools" | "skills" | "compaction" | "interactive";
type ParsedListFieldName = "tools" | "skills";
type ParsedBooleanFieldName = "compaction" | "interactive";
type WarningSubject = "subagent" | "subagent override";

type ParsedFieldWarning =
	| { code: "invalid-list-format"; fieldName: ParsedListFieldName }
	| { code: "invalid-type"; fieldName: ParsedFieldName; expected: "string" | "boolean" }
	| { code: "invalid-model-format"; model: string }
	| { code: "invalid-thinking-level"; thinking: string };

interface ParsedFieldSet extends AgentConfigFields {
	warnings: ParsedFieldWarning[];
}

interface ParseFieldOptions {
	warnOnInvalidType: boolean;
	setValueOnInvalidType: boolean;
}

interface ParseResult {
	agent: AgentConfig | null;
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
	"max",
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

function parseCommaSeparated(value: unknown): string[] | undefined {
	if (value == null) return undefined;
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
	return undefined;
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
	}
}

function toParseWarnings(
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
	return { values: [], warnings: [{ code: "invalid-list-format", fieldName }] };
}

function parseModel(value: unknown): ParsedModel | null {
	if (typeof value !== "string" || !value.includes("/")) return null;
	const slashIndex = value.indexOf("/");
	const provider = value.slice(0, slashIndex).trim();
	const modelId = value.slice(slashIndex + 1).trim();
	return provider && modelId ? { provider, modelId } : null;
}

function validateThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	return VALID_THINKING_LEVELS.includes(value) ? value as ThinkingLevel : undefined;
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
		return { model: value, parsedModel, warnings: [] };
	}
	if (value !== undefined && options.warnOnInvalidType) {
		return { warnings: [{ code: "invalid-type", fieldName: "model", expected: "string" }] };
	}
	return { warnings: [] };
}

function parseThinkingField(value: unknown, options: ParseFieldOptions): Pick<ParsedFieldSet, "thinking" | "warnings"> {
	if (typeof value === "string") {
		const thinking = validateThinkingLevel(value);
		return thinking ? { thinking, warnings: [] } : { warnings: [{ code: "invalid-thinking-level", thinking: value }] };
	}
	if (value !== undefined && options.warnOnInvalidType) {
		return { warnings: [{ code: "invalid-type", fieldName: "thinking", expected: "string" }] };
	}
	return { warnings: [] };
}

function parseToolsField(value: unknown, options: ParseFieldOptions): Pick<ParsedFieldSet, "tools" | "warnings"> {
	const parsedTools = parseListField(value, "tools");
	if (parsedTools.warnings.length > 0 && !options.setValueOnInvalidType) return { warnings: parsedTools.warnings };
	return { tools: parsedTools.values, warnings: parsedTools.warnings };
}

function parseSkillsField(value: unknown, options: ParseFieldOptions): Pick<ParsedFieldSet, "skills" | "warnings"> {
	const parsedSkills = parseListField(value, "skills");
	if (parsedSkills.warnings.length > 0 && !options.setValueOnInvalidType) return { warnings: parsedSkills.warnings };
	return { skills: parsedSkills.values, warnings: parsedSkills.warnings };
}

function parseBooleanField(
	fieldName: ParsedBooleanFieldName,
	value: unknown,
	options: ParseFieldOptions,
): Pick<ParsedFieldSet, ParsedBooleanFieldName | "warnings"> {
	if (typeof value === "boolean") return { [fieldName]: value, warnings: [] };
	if (value !== undefined && options.warnOnInvalidType) {
		return { warnings: [{ code: "invalid-type", fieldName, expected: "boolean" }] };
	}
	return { warnings: [] };
}

function parseSharedFields(record: Record<string, unknown>, options: ParseFieldOptions): ParsedFieldSet {
	const model = parseModelField(record.model, options);
	const thinking = parseThinkingField(record.thinking, options);
	const tools = Object.prototype.hasOwnProperty.call(record, "tools") ? parseToolsField(record.tools, options) : { warnings: [] };
	const skills = Object.prototype.hasOwnProperty.call(record, "skills") ? parseSkillsField(record.skills, options) : { warnings: [] };
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

function parseDefinitionFields(
	record: Record<string, unknown>,
	filePath: string,
	agentName: string,
): { fields: AgentConfigFields; warnings: AgentDiscoveryWarning[] } {
	const parsed = parseSharedFields(record, { warnOnInvalidType: false, setValueOnInvalidType: true });
	const { warnings, ...fields } = parsed;
	return { fields, warnings: toParseWarnings(filePath, "subagent", agentName, warnings) };
}

function parseOverrideFields(
	record: Record<string, unknown>,
	filePath: string,
	agentName: string,
): { fields: AgentConfigFields; warnings: AgentDiscoveryWarning[] } {
	const warnings: AgentDiscoveryWarning[] = [];
	for (const fieldName of Object.keys(record)) {
		if (fieldName === "name" || fieldName === "description") {
			warnings.push(createDiscoveryWarning(filePath, `Subagent override "${agentName}": field "${fieldName}" is not overridable, ignoring`));
			continue;
		}
		if (!ALLOWED_OVERRIDE_FIELDS.has(fieldName)) {
			warnings.push(createDiscoveryWarning(filePath, `Subagent override "${agentName}": unknown field "${fieldName}", ignoring`));
		}
	}

	const parsed = parseSharedFields(record, { warnOnInvalidType: true, setValueOnInvalidType: false });
	const { warnings: fieldWarnings, ...fields } = parsed;
	warnings.push(...toParseWarnings(filePath, "subagent override", agentName, fieldWarnings));
	return { fields, warnings };
}

function parseAgentDefinition(content: string, filePath: string): ParseResult {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = piCodingAgent.parseFrontmatter<Record<string, unknown>>(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { agent: null, warnings: [createDiscoveryWarning(filePath, `Ignored invalid subagent definition. Frontmatter could not be parsed: ${reason}`)] };
	}

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : undefined;
	if (!name || !description) {
		return { agent: null, warnings: [createDiscoveryWarning(filePath, 'Ignored invalid subagent definition. Required frontmatter fields "name" and "description" must be non-empty strings.')] };
	}
	if (/\s/.test(name)) {
		return { agent: null, warnings: [createDiscoveryWarning(filePath, `Ignored subagent definition "${name}". Subagent names cannot contain whitespace. Use "-" instead.`)] };
	}

	const parsedFields = parseDefinitionFields(frontmatter, filePath, name);
	return {
		agent: { name, description, ...parsedFields.fields, systemPrompt: body, filePath },
		warnings: parsedFields.warnings,
	};
}

function parseAgentOverride(
	agentName: string,
	value: unknown,
	filePath: string,
): { override: AgentConfigOverride | null; warnings: AgentDiscoveryWarning[] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { override: null, warnings: [createDiscoveryWarning(filePath, `Subagent override "${agentName}" must be a JSON object, ignoring`)] };
	}
	const parsedFields = parseOverrideFields(value as Record<string, unknown>, filePath, agentName);
	return { override: parsedFields.fields, warnings: parsedFields.warnings };
}

function parseConfigFile(content: string, filePath: string): ConfigParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { overrides: {}, overrideSources: {}, warnings: [createDiscoveryWarning(filePath, `Ignored pi-crew config. JSON could not be parsed: ${reason}`)] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { overrides: {}, overrideSources: {}, warnings: [createDiscoveryWarning(filePath, "Ignored pi-crew config. Root value must be a JSON object.")] };
	}

	const root = parsed as Record<string, unknown>;
	if (root.agents === undefined) return { overrides: {}, overrideSources: {}, warnings: [] };
	if (!root.agents || typeof root.agents !== "object" || Array.isArray(root.agents)) {
		return { overrides: {}, overrideSources: {}, warnings: [createDiscoveryWarning(filePath, 'Ignored pi-crew config. Field "agents" must be a JSON object.')] };
	}

	const overrides: Record<string, AgentConfigOverride> = {};
	const overrideSources: Record<string, string> = {};
	const warnings: AgentDiscoveryWarning[] = [];
	for (const [agentName, value] of Object.entries(root.agents)) {
		if (!agentName.trim()) {
			warnings.push(createDiscoveryWarning(filePath, "Ignored pi-crew config entry with empty subagent name."));
			continue;
		}
		const parsedOverride = parseAgentOverride(agentName, value, filePath);
		warnings.push(...parsedOverride.warnings);
		if (parsedOverride.override) {
			overrides[agentName] = parsedOverride.override;
			overrideSources[agentName] = filePath;
		}
	}
	return { overrides, overrideSources, warnings };
}

function mergeConfigOverrides(
	base: Record<string, AgentConfigOverride>,
	override: Record<string, AgentConfigOverride>,
): Record<string, AgentConfigOverride> {
	const merged: Record<string, AgentConfigOverride> = { ...base };
	for (const [agentName, agentOverride] of Object.entries(override)) {
		merged[agentName] = { ...(merged[agentName] ?? {}), ...agentOverride };
	}
	return merged;
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

function loadAgentDefinitionFromFile(file: AgentDefinitionFile): ParseResult {
	if (!file.content) return { agent: null, warnings: file.warnings ?? [] };
	const parsed = parseAgentDefinition(file.content, file.filePath);
	return { agent: parsed.agent, warnings: [...(file.warnings ?? []), ...parsed.warnings] };
}

function mergeConfigFiles(configFiles: AgentConfigFile[]): ConfigParseResult {
	let overrides: Record<string, AgentConfigOverride> = {};
	let overrideSources: Record<string, string> = {};
	const warnings: AgentDiscoveryWarning[] = [];

	for (const configFile of configFiles) {
		warnings.push(...(configFile.warnings ?? []));
		if (!configFile.content) continue;
		const parsed = parseConfigFile(configFile.content, configFile.filePath);
		overrides = mergeConfigOverrides(overrides, parsed.overrides);
		overrideSources = { ...overrideSources, ...parsed.overrideSources };
		warnings.push(...parsed.warnings);
	}

	return { overrides, overrideSources, warnings };
}

export class AgentCatalog {
	constructor(private readonly source: AgentCatalogSource) {}

	discover(cwd: string = process.cwd()): AgentDiscoveryResult {
		const agents: AgentConfig[] = [];
		const warnings: AgentDiscoveryWarning[] = [];
		const seenNames = new Map<string, string>();

		for (const group of this.source.loadAgentDefinitionGroups(cwd)) {
			this.loadAgentsFromGroup(group, seenNames, agents, warnings);
		}

		const configOverrides = mergeConfigFiles(this.source.loadConfigFiles(cwd));
		warnings.push(...configOverrides.warnings);

		const finalAgents = agents.map((agent) => {
			const override = configOverrides.overrides[agent.name];
			return override ? applyAgentOverride(agent, override) : agent;
		});

		for (const agentName of Object.keys(configOverrides.overrides)) {
			if (!seenNames.has(agentName)) {
				warnings.push(createDiscoveryWarning(
					configOverrides.overrideSources[agentName] ?? "pi-crew.json",
					`Subagent override "${agentName}" does not match any discovered subagent, ignoring`,
				));
			}
		}

		return { agents: finalAgents, warnings };
	}

	private loadAgentsFromGroup(
		group: AgentDefinitionSourceGroup,
		seenNames: Map<string, string>,
		agents: AgentConfig[],
		warnings: AgentDiscoveryWarning[],
	): void {
		warnings.push(...(group.warnings ?? []));
		const groupNames = new Set<string>();

		for (const file of group.files) {
			const loaded = loadAgentDefinitionFromFile(file);
			warnings.push(...loaded.warnings);
			if (!loaded.agent) continue;

			const { name } = loaded.agent;
			if (groupNames.has(name)) {
				warnings.push(createDiscoveryWarning(file.filePath, `Duplicate subagent name "${name}" in ${group.agentsDir}, skipping`));
				continue;
			}
			groupNames.add(name);
			if (seenNames.has(name)) continue;
			seenNames.set(name, file.filePath);
			agents.push(loaded.agent);
		}
	}
}

function loadAgentFile(filePath: string): AgentDefinitionFile {
	try {
		return { filePath, content: fs.readFileSync(filePath, "utf-8") };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			filePath,
			content: null,
			warnings: [createDiscoveryWarning(filePath, `Ignored subagent definition. File could not be read: ${reason}`)],
		};
	}
}

function loadAgentDefinitionGroup(agentsDir: string): AgentDefinitionSourceGroup | null {
	if (!fs.existsSync(agentsDir)) return null;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { agentsDir, files: [], warnings: [createDiscoveryWarning(agentsDir, `Subagent directory could not be read: ${reason}`)] };
	}
	return {
		agentsDir,
		files: entries
			.filter((entry) => entry.name.endsWith(".md"))
			.filter((entry) => entry.isFile() || entry.isSymbolicLink())
			.map((entry) => loadAgentFile(path.join(agentsDir, entry.name))),
	};
}

function loadConfigFile(filePath: string): AgentConfigFile | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		return { filePath, content: fs.readFileSync(filePath, "utf-8") };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { filePath, content: null, warnings: [createDiscoveryWarning(filePath, `Ignored pi-crew config. File could not be read: ${reason}`)] };
	}
}

const bundledAgentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");

class FilesystemAgentCatalogSource implements AgentCatalogSource {
	loadAgentDefinitionGroups(cwd: string): AgentDefinitionSourceGroup[] {
		return [path.join(cwd, PROJECT_CONFIG_DIR_NAME, "agents"), path.join(piCodingAgent.getAgentDir(), "agents"), bundledAgentsDir]
			.map(loadAgentDefinitionGroup)
			.filter((group): group is AgentDefinitionSourceGroup => group !== null);
	}

	loadConfigFiles(cwd: string): AgentConfigFile[] {
		return [path.join(piCodingAgent.getAgentDir(), "pi-crew.json"), path.join(cwd, PROJECT_CONFIG_DIR_NAME, "pi-crew.json")]
			.map(loadConfigFile)
			.filter((file): file is AgentConfigFile => file !== null);
	}
}

export function discoverAgents(cwd: string = process.cwd()): AgentDiscoveryResult {
	return new AgentCatalog(new FilesystemAgentCatalogSource()).discover(cwd);
}
