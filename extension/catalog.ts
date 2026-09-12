import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { parseModelId } from "./format.js";

const PROJECT_CONFIG_DIR_NAME = piCodingAgent.CONFIG_DIR_NAME ?? ".pi";

export const BUILT_IN_TOOL_NAMES: readonly string[] = Object.freeze([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

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

export interface CrewWidgetConfig {
	showToolCalls: boolean;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	warnings: AgentDiscoveryWarning[];
	widget: CrewWidgetConfig;
}

const DEFAULT_WIDGET_CONFIG: CrewWidgetConfig = { showToolCalls: true };
type WidgetConfigOverride = Partial<CrewWidgetConfig>;

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

export interface AgentDiscoveryOptions {
	projectTrusted: boolean;
}

export interface AgentCatalogSource {
	loadAgentDefinitionGroups(cwd: string, options: AgentDiscoveryOptions): AgentDefinitionSourceGroup[];
	loadConfigFiles(cwd: string, options: AgentDiscoveryOptions): AgentConfigFile[];
}

type ToolsDelta = Array<{ action: "add" | "remove"; name: string }>;

type ToolOperation = ToolsDelta[number] | { action: "reset"; tools: string[] };
type AgentConfigOverride = Omit<AgentConfigFields, "tools"> & { toolOperations?: ToolOperation[] };
type ParsedFieldName = "model" | "thinking" | "tools" | "skills" | "compaction";
type ParsedListFieldName = "tools" | "skills";
type ParsedBooleanFieldName = "compaction";
type WarningSubject = "subagent" | "subagent override";

type ParsedFieldWarning =
	| { code: "invalid-list-format"; fieldName: ParsedListFieldName }
	| { code: "mixed-tools-delta" }
	| { code: "invalid-type"; fieldName: ParsedFieldName; expected: "string" | "boolean" }
	| { code: "invalid-model-format"; model: string }
	| { code: "invalid-thinking-level"; thinking: string };

interface ParsedFieldSet extends AgentConfigFields {
	toolsDelta?: ToolsDelta;
	warnings: ParsedFieldWarning[];
}

interface ParseResult {
	agent: AgentConfig | null;
	warnings: AgentDiscoveryWarning[];
}

interface ConfigParseResult {
	overrides: Record<string, AgentConfigOverride>;
	overrideSources: Record<string, string>;
	widget: WidgetConfigOverride;
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
			return `${prefix}: invalid model format "${warning.model}" (expected "provider/model-id"); spawning this subagent will fail until it is fixed`;
		case "invalid-thinking-level":
			return `${prefix}: invalid thinking level "${warning.thinking}", ignoring`;
		case "mixed-tools-delta":
			return `${prefix}: tools field mixes "+"/"-" entries with plain names, ignoring tools field`;
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

function validateThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) return undefined;
	return VALID_THINKING_LEVELS.includes(value) ? value as ThinkingLevel : undefined;
}

/** A malformed model keeps its raw value so the spawn fails loudly instead of falling back to another model. */
function parseModelField(value: unknown): Pick<ParsedFieldSet, "model" | "parsedModel" | "warnings"> {
	if (typeof value === "string") {
		const parsedModel = parseModelId(value);
		if (!parsedModel) {
			return { model: value, parsedModel: undefined, warnings: [{ code: "invalid-model-format", model: value }] };
		}
		return { model: value, parsedModel, warnings: [] };
	}
	if (value !== undefined) {
		return { warnings: [{ code: "invalid-type", fieldName: "model", expected: "string" }] };
	}
	return { warnings: [] };
}

function parseThinkingField(value: unknown): Pick<ParsedFieldSet, "thinking" | "warnings"> {
	if (typeof value === "string") {
		const thinking = validateThinkingLevel(value);
		return thinking ? { thinking, warnings: [] } : { warnings: [{ code: "invalid-thinking-level", thinking: value }] };
	}
	if (value !== undefined) {
		return { warnings: [{ code: "invalid-type", fieldName: "thinking", expected: "string" }] };
	}
	return { warnings: [] };
}

function isDeltaEntry(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-");
}

function parseToolsField(value: unknown): Pick<ParsedFieldSet, "tools" | "toolsDelta" | "warnings"> {
	const parsedTools = parseListField(value, "tools");
	if (parsedTools.warnings.length > 0) return { warnings: parsedTools.warnings };

	const deltaCount = parsedTools.values.filter(isDeltaEntry).length;
	if (deltaCount === 0) return { tools: parsedTools.values, warnings: [] };
	if (deltaCount !== parsedTools.values.length) return { warnings: [{ code: "mixed-tools-delta" }] };

	const toolsDelta: ToolsDelta = [];
	for (const entry of parsedTools.values) {
		const name = entry.slice(1).trim();
		if (!name) continue;
		toolsDelta.push({ action: entry.startsWith("+") ? "add" : "remove", name });
	}
	return { toolsDelta, warnings: [] };
}

function parseSkillsField(value: unknown): Pick<ParsedFieldSet, "skills" | "warnings"> {
	const parsedSkills = parseListField(value, "skills");
	if (parsedSkills.warnings.length > 0) return { warnings: parsedSkills.warnings };
	return { skills: parsedSkills.values, warnings: [] };
}

function parseBooleanField(
	fieldName: ParsedBooleanFieldName,
	value: unknown,
): Pick<ParsedFieldSet, ParsedBooleanFieldName | "warnings"> {
	if (typeof value === "boolean") return { [fieldName]: value, warnings: [] };
	if (value !== undefined) {
		return { warnings: [{ code: "invalid-type", fieldName, expected: "boolean" }] };
	}
	return { warnings: [] };
}

function parseSharedFields(record: Record<string, unknown>): ParsedFieldSet {
	const model = parseModelField(record.model);
	const thinking = parseThinkingField(record.thinking);
	const tools = Object.prototype.hasOwnProperty.call(record, "tools") ? parseToolsField(record.tools) : { warnings: [] };
	const skills = Object.prototype.hasOwnProperty.call(record, "skills") ? parseSkillsField(record.skills) : { warnings: [] };
	const compaction = parseBooleanField("compaction", record.compaction);

	return {
		...("model" in model ? { model: model.model } : {}),
		...("parsedModel" in model ? { parsedModel: model.parsedModel } : {}),
		...(thinking.thinking !== undefined ? { thinking: thinking.thinking } : {}),
		...(tools.tools !== undefined ? { tools: tools.tools } : {}),
		...(tools.toolsDelta !== undefined ? { toolsDelta: tools.toolsDelta } : {}),
		...(skills.skills !== undefined ? { skills: skills.skills } : {}),
		...(compaction.compaction !== undefined ? { compaction: compaction.compaction } : {}),
		warnings: [
			...model.warnings,
			...thinking.warnings,
			...tools.warnings,
			...skills.warnings,
			...compaction.warnings,
		],
	};
}

function parseDefinitionFields(
	record: Record<string, unknown>,
	filePath: string,
	agentName: string,
): { fields: AgentConfigFields; warnings: AgentDiscoveryWarning[] } {
	const { warnings, toolsDelta, ...fields } = parseSharedFields(record);
	return {
		fields: {
			...fields,
			...(toolsDelta !== undefined ? { tools: applyToolOperations(BUILT_IN_TOOL_NAMES, toolsDelta) } : {}),
		},
		warnings: toParseWarnings(filePath, "subagent", agentName, warnings),
	};
}

function parseOverrideFields(
	record: Record<string, unknown>,
	filePath: string,
	agentName: string,
): { fields: AgentConfigOverride; warnings: AgentDiscoveryWarning[] } {
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

	const { warnings: fieldWarnings, tools, toolsDelta, ...rest } = parseSharedFields(record);
	const toolOperations: ToolOperation[] | undefined = tools !== undefined
		? [{ action: "reset", tools }]
		: toolsDelta;
	warnings.push(...toParseWarnings(filePath, "subagent override", agentName, fieldWarnings));
	return { fields: { ...rest, ...(toolOperations !== undefined ? { toolOperations } : {}) }, warnings };
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

function parseWidgetConfig(value: unknown, filePath: string): { config: WidgetConfigOverride; warnings: AgentDiscoveryWarning[] } {
	if (value === undefined) return { config: {}, warnings: [] };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { config: {}, warnings: [createDiscoveryWarning(filePath, 'Widget: field "widget" must be a JSON object, ignoring')] };
	}

	const record = value as Record<string, unknown>;
	const config: WidgetConfigOverride = {};
	const warnings: AgentDiscoveryWarning[] = [];
	if (record.showToolCalls !== undefined) {
		if (typeof record.showToolCalls === "boolean") config.showToolCalls = record.showToolCalls;
		else warnings.push(createDiscoveryWarning(filePath, 'Widget: field "showToolCalls" must be a boolean, ignoring'));
	}
	return { config, warnings };
}

function parseConfigFile(content: string, filePath: string): ConfigParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { overrides: {}, overrideSources: {}, widget: {}, warnings: [createDiscoveryWarning(filePath, `Ignored pi-crew config. JSON could not be parsed: ${reason}`)] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { overrides: {}, overrideSources: {}, widget: {}, warnings: [createDiscoveryWarning(filePath, "Ignored pi-crew config. Root value must be a JSON object.")] };
	}

	const root = parsed as Record<string, unknown>;
	const overrides: Record<string, AgentConfigOverride> = {};
	const overrideSources: Record<string, string> = {};
	const warnings: AgentDiscoveryWarning[] = [];

	if (root.agents !== undefined) {
		if (!root.agents || typeof root.agents !== "object" || Array.isArray(root.agents)) {
			warnings.push(createDiscoveryWarning(filePath, 'Ignored pi-crew config. Field "agents" must be a JSON object.'));
		} else {
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
		}
	}

	const widgetConfig = parseWidgetConfig(root.widget, filePath);
	warnings.push(...widgetConfig.warnings);
	return { overrides, overrideSources, widget: widgetConfig.config, warnings };
}

function mergeConfigOverrides(
	base: Record<string, AgentConfigOverride>,
	override: Record<string, AgentConfigOverride>,
): Record<string, AgentConfigOverride> {
	const merged: Record<string, AgentConfigOverride> = { ...base };
	for (const [agentName, agentOverride] of Object.entries(override)) {
		const previous = merged[agentName];
		merged[agentName] = {
			...previous,
			...agentOverride,
			...(agentOverride.toolOperations !== undefined
				? { toolOperations: [...(previous?.toolOperations ?? []), ...agentOverride.toolOperations] }
				: {}),
		};
	}
	return merged;
}

function applyToolOperations(base: readonly string[], operations: ToolOperation[]): string[] {
	let tools = [...base];
	for (const operation of operations) {
		if (operation.action === "reset") tools = [...operation.tools];
		else if (operation.action === "remove") tools = tools.filter((tool) => tool !== operation.name);
		else if (!tools.includes(operation.name)) tools.push(operation.name);
	}
	return tools;
}

function applyAgentOverride(agent: AgentConfig, override: AgentConfigOverride): AgentConfig {
	return {
		...agent,
		...(override.model !== undefined ? { model: override.model, parsedModel: override.parsedModel } : {}),
		...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
		...(override.toolOperations !== undefined
			? { tools: applyToolOperations(agent.tools ?? BUILT_IN_TOOL_NAMES, override.toolOperations) }
			: {}),
		...(override.skills !== undefined ? { skills: override.skills } : {}),
		...(override.compaction !== undefined ? { compaction: override.compaction } : {}),
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
	let widget: WidgetConfigOverride = {};
	const warnings: AgentDiscoveryWarning[] = [];

	for (const configFile of configFiles) {
		warnings.push(...(configFile.warnings ?? []));
		if (!configFile.content) continue;
		const parsed = parseConfigFile(configFile.content, configFile.filePath);
		overrides = mergeConfigOverrides(overrides, parsed.overrides);
		overrideSources = { ...overrideSources, ...parsed.overrideSources };
		widget = { ...widget, ...parsed.widget };
		warnings.push(...parsed.warnings);
	}

	return { overrides, overrideSources, widget, warnings };
}

export class AgentCatalog {
	constructor(private readonly source: AgentCatalogSource) {}

	discover(cwd: string, options: AgentDiscoveryOptions): AgentDiscoveryResult {
		const agents: AgentConfig[] = [];
		const warnings: AgentDiscoveryWarning[] = [];
		const seenNames = new Map<string, string>();

		for (const group of this.source.loadAgentDefinitionGroups(cwd, options)) {
			this.loadAgentsFromGroup(group, seenNames, agents, warnings);
		}

		const configOverrides = mergeConfigFiles(this.source.loadConfigFiles(cwd, options));
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

		return { agents: finalAgents, warnings, widget: { ...DEFAULT_WIDGET_CONFIG, ...configOverrides.widget } };
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

const UNTRUSTED_PROJECT_WARNING = "Project subagent resources were not loaded because the project is not trusted.";

function projectAgentsDirPath(cwd: string): string {
	return path.join(cwd, PROJECT_CONFIG_DIR_NAME, "agents");
}

function projectConfigPath(cwd: string): string {
	return path.join(cwd, PROJECT_CONFIG_DIR_NAME, "pi-crew.json");
}

class FilesystemAgentCatalogSource implements AgentCatalogSource {
	loadAgentDefinitionGroups(cwd: string, options: AgentDiscoveryOptions): AgentDefinitionSourceGroup[] {
		const agentsDirs = [path.join(piCodingAgent.getAgentDir(), "agents"), bundledAgentsDir];
		if (options.projectTrusted) agentsDirs.unshift(projectAgentsDirPath(cwd));

		const groups = agentsDirs
			.map(loadAgentDefinitionGroup)
			.filter((group): group is AgentDefinitionSourceGroup => group !== null);

		const untrustedWarning = options.projectTrusted ? null : this.untrustedProjectGroup(cwd);
		return untrustedWarning ? [untrustedWarning, ...groups] : groups;
	}

	loadConfigFiles(cwd: string, options: AgentDiscoveryOptions): AgentConfigFile[] {
		const configPaths = [path.join(piCodingAgent.getAgentDir(), "pi-crew.json")];
		if (options.projectTrusted) configPaths.push(projectConfigPath(cwd));
		return configPaths
			.map(loadConfigFile)
			.filter((file): file is AgentConfigFile => file !== null);
	}

	/** One warning covers both skipped project sources, so it is reported with the definition groups. */
	private untrustedProjectGroup(cwd: string): AgentDefinitionSourceGroup | null {
		const agentsDir = projectAgentsDirPath(cwd);
		const skippedPath = [agentsDir, projectConfigPath(cwd)].find((candidate) => fs.existsSync(candidate));
		if (!skippedPath) return null;
		return { agentsDir, files: [], warnings: [createDiscoveryWarning(skippedPath, UNTRUSTED_PROJECT_WARNING)] };
	}
}

export function discoverAgents(cwd: string, options: AgentDiscoveryOptions): AgentDiscoveryResult {
	return new AgentCatalog(new FilesystemAgentCatalogSource()).discover(cwd, options);
}
