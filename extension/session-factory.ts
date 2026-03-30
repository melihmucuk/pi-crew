import {
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { createSupportedTools, SUPPORTED_TOOL_NAMES } from "./tool-registry.js";

function resolveTools(agentConfig: AgentConfig, cwd: string) {
	return createSupportedTools(agentConfig.tools ?? SUPPORTED_TOOL_NAMES, cwd);
}

function resolveModel(
	agentConfig: AgentConfig,
	ctx: ExtensionContext,
) {
	const model = ctx.model;
	if (!agentConfig.parsedModel) return model;

	const found = ctx.modelRegistry.find(
		agentConfig.parsedModel.provider,
		agentConfig.parsedModel.modelId,
	);
	if (found) return found;

	console.warn(
		`[pi-crew] Agent "${agentConfig.name}": model "${agentConfig.model}" not found in registry, using default`,
	);
	return model;
}

function warnUnknownSkills(agentConfig: AgentConfig, resourceLoader: DefaultResourceLoader): void {
	if (!agentConfig.skills) return;

	const availableSkillNames = new Set(
		resourceLoader.getSkills().skills.map((skill) => skill.name),
	);
	const unknownSkills = agentConfig.skills.filter((skillName) => !availableSkillNames.has(skillName));
	if (unknownSkills.length === 0) return;

	console.warn(
		`[pi-crew] Agent "${agentConfig.name}": unknown skills ${unknownSkills.map((skillName) => `"${skillName}"`).join(", ")}, ignoring`,
	);
}

interface BootstrapOptions {
	agentConfig: AgentConfig;
	cwd: string;
	ctx: ExtensionContext;
	extensionResolvedPath: string;
	parentSessionFile?: string;
}

export async function bootstrapSession(
	opts: BootstrapOptions,
): Promise<CreateAgentSessionResult> {
	const { agentConfig, cwd, ctx, extensionResolvedPath, parentSessionFile } = opts;

	const authStorage = ctx.modelRegistry.authStorage;
	const modelRegistry = ctx.modelRegistry;
	const model = resolveModel(agentConfig, ctx);
	const tools = resolveTools(agentConfig, cwd);

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter(
				(ext) => !ext.resolvedPath.startsWith(extensionResolvedPath),
			),
		}),
		skillsOverride: agentConfig.skills
			? (base) => ({
					skills: base.skills.filter((skill) => agentConfig.skills!.includes(skill.name)),
					diagnostics: base.diagnostics,
				})
			: undefined,
		appendSystemPromptOverride: (base) =>
			agentConfig.systemPrompt.trim() ? [...base, agentConfig.systemPrompt] : base,
	});
	await resourceLoader.reload();
	warnUnknownSkills(agentConfig, resourceLoader);

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: agentConfig.compaction ?? true },
	});

	const sessionManager = SessionManager.create(cwd);
	sessionManager.newSession({ parentSession: parentSessionFile });

	return createAgentSession({
		cwd,
		model,
		thinkingLevel: agentConfig.thinking,
		tools,
		resourceLoader,
		sessionManager,
		settingsManager,
		authStorage,
		modelRegistry,
	});
}
