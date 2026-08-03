import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	type ModelRegistry,
	type ProviderConfig,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./catalog.js";
import type { SubagentState, SubagentToolActivity } from "./crew.js";
import { formatCrewTask } from "./task.js";
import { summarizeToolTarget } from "./tool-activity.js";
import type { SubagentStatus } from "./ui.js";

const BUILT_IN_TOOL_NAMES = Object.freeze([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

export interface BootstrapContext {
	model: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	agentDir: string;
	parentSessionFile?: string;
}

interface BootstrapOptions {
	agentConfig: AgentConfig;
	cwd: string;
	ctx: BootstrapContext;
	extensionResolvedPath: string;
}

interface BootstrapResult {
	session: AgentSession;
	warnings: string[];
}

interface PromptOutcome {
	status: Extract<SubagentStatus, "done" | "waiting" | "error" | "aborted">;
	result?: string;
	error?: string;
}

interface StartOptions {
	cwd: string;
	ctx: BootstrapContext;
	extensionResolvedPath: string;
	onWarning?: (message: string) => void;
}

export interface SubagentRunnerCallbacks {
	isCurrent: (state: SubagentState) => boolean;
	onProgress: (ownerSessionId: string) => void;
	onToolStart: (state: SubagentState, tool: Omit<SubagentToolActivity, "status">) => void;
	onToolEnd: (state: SubagentState, toolCallId: string, isError: boolean) => void;
	onSettled: (
		state: SubagentState,
		status: Extract<SubagentStatus, "done" | "waiting" | "error" | "aborted">,
		outcome: { result?: string; error?: string },
	) => void;
}

export interface SubagentRunner {
	start(state: SubagentState, opts: StartOptions): void;
	respond(state: SubagentState, message: string): void;
	abort(state: SubagentState): void;
}

function resolveTools(agentConfig: AgentConfig): string[] {
	return [...(agentConfig.tools ?? BUILT_IN_TOOL_NAMES)];
}

function resolveModel(
	agentConfig: AgentConfig,
	currentModel: Model<Api> | undefined,
	modelRuntime: ModelRuntime,
): Model<Api> | undefined {
	if (!agentConfig.parsedModel) {
		if (agentConfig.model !== undefined) {
			throw new Error(`Configured model "${agentConfig.model}" is invalid; expected "provider/model-id"`);
		}
		return currentModel;
	}

	const found = modelRuntime.getModel(agentConfig.parsedModel.provider, agentConfig.parsedModel.modelId);
	if (found) return found;

	throw new Error(`Configured model "${agentConfig.model}" is not available; subagent was not started`);
}

function getRequiredProviderIds(agentConfig: AgentConfig, ctx: BootstrapContext): Set<string> {
	const providerIds = new Set<string>();
	if (agentConfig.parsedModel) providerIds.add(agentConfig.parsedModel.provider);
	else if (agentConfig.model === undefined && ctx.model) providerIds.add(ctx.model.provider);
	return providerIds;
}

function snapshotProviderConfig(
	providerId: string,
	config: ProviderConfig,
	ownerModels: Model<Api>[],
): ProviderConfig {
	if (!config.refreshModels) return config;
	return {
		...config,
		refreshModels: undefined,
		models: ownerModels.filter((model) => model.provider === providerId),
	};
}

async function transferRuntimeApiKey(
	providerId: string,
	ownerRegistry: ModelRegistry,
	modelRuntime: ModelRuntime,
): Promise<void> {
	const apiKey = await ownerRegistry.getApiKeyForProvider(providerId);
	if (!apiKey) {
		throw new Error(`Configured authentication for provider "${providerId}" cannot be transferred to the subagent runtime`);
	}
	await modelRuntime.setRuntimeApiKey(providerId, apiKey, { allowNetwork: false });
}

async function createChildModelRuntime(agentConfig: AgentConfig, ctx: BootstrapContext): Promise<ModelRuntime> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(ctx.agentDir, "auth.json"),
		modelsPath: join(ctx.agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const requiredProviderIds = getRequiredProviderIds(agentConfig, ctx);
	const ownerModels = ctx.modelRegistry.getAll();

	for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
		const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
		if (nativeProvider) {
			modelRuntime.registerNativeProvider(nativeProvider);
			continue;
		}

		const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
		if (config) modelRuntime.registerProvider(providerId, snapshotProviderConfig(providerId, config, ownerModels));
	}

	for (const providerId of requiredProviderIds) {
		const ownerAuth = ctx.modelRegistry.getProviderAuthStatus(providerId);
		if (ownerAuth.configured && ownerAuth.source === "runtime") {
			await transferRuntimeApiKey(providerId, ctx.modelRegistry, modelRuntime);
		}
	}

	for (const providerId of requiredProviderIds) {
		const ownerAuth = ctx.modelRegistry.getProviderAuthStatus(providerId);
		if (ownerAuth.configured && !await modelRuntime.checkAuth(providerId)) {
			await transferRuntimeApiKey(providerId, ctx.modelRegistry, modelRuntime);
		}
	}

	return modelRuntime;
}

function getSkillWarnings(agentConfig: AgentConfig, resourceLoader: DefaultResourceLoader): string[] {
	const warnings: string[] = [];
	if (!agentConfig.skills) return warnings;

	const availableSkillNames = new Set(resourceLoader.getSkills().skills.map((skill) => skill.name));
	for (const skillName of agentConfig.skills) {
		if (!availableSkillNames.has(skillName)) {
			warnings.push(`Unknown skill "${skillName}" in subagent config, skipping`);
		}
	}
	return warnings;
}

async function bootstrapSession(opts: BootstrapOptions): Promise<BootstrapResult> {
	const warnings: string[] = [];
	const { agentConfig, cwd, ctx, extensionResolvedPath } = opts;

	const modelRuntime = await createChildModelRuntime(agentConfig, ctx);
	const model = resolveModel(agentConfig, ctx.model, modelRuntime);
	const tools = resolveTools(agentConfig);

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: ctx.agentDir,
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter((ext) => !ext.resolvedPath.startsWith(extensionResolvedPath)),
		}),
		skillsOverride: agentConfig.skills
			? (base) => ({
				skills: base.skills.filter((skill) => agentConfig.skills!.includes(skill.name)),
				diagnostics: base.diagnostics,
			})
			: undefined,
		appendSystemPromptOverride: (base) => agentConfig.systemPrompt.trim() ? [...base, agentConfig.systemPrompt] : base,
	});
	await resourceLoader.reload();
	warnings.push(...getSkillWarnings(agentConfig, resourceLoader));

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: agentConfig.compaction ?? true },
	});

	const sessionDir = ctx.parentSessionFile ? dirname(ctx.parentSessionFile) : join(ctx.agentDir, "sessions");
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.newSession({ parentSession: ctx.parentSessionFile });

	const result = await createAgentSession({
		cwd,
		agentDir: ctx.agentDir,
		model,
		thinkingLevel: agentConfig.thinking,
		tools,
		resourceLoader,
		sessionManager,
		settingsManager,
		modelRuntime,
	});

	return { session: result.session, warnings };
}

function getLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") return msg as AssistantMessage;
	}
	return undefined;
}

function getAssistantText(message: AssistantMessage | undefined): string | undefined {
	if (!message) return undefined;
	const texts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") texts.push(part.text);
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

function getPromptOutcome(state: SubagentState): PromptOutcome {
	const lastAssistant = getLastAssistantMessage(state.session!.messages);
	const text = getAssistantText(lastAssistant);

	if (lastAssistant?.stopReason === "error") {
		return { status: "error", error: lastAssistant.errorMessage ?? text ?? "(no output)" };
	}
	if (lastAssistant?.stopReason === "aborted") {
		return { status: "aborted", error: lastAssistant.errorMessage ?? text ?? "(no output)" };
	}
	return { status: state.agentConfig.interactive ? "waiting" : "done", result: text ?? "(no output)" };
}

function isAborted(state: SubagentState): boolean {
	return state.status === "aborted";
}

function normalizeSessionNamePart(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function formatSubagentSessionName(state: Pick<SubagentState, "agentConfig" | "brief" | "id">): string {
	const agentName = normalizeSessionNamePart(state.agentConfig.name) || "subagent";
	const brief = normalizeSessionNamePart(state.brief) || state.id;
	return `crew: ${agentName} · ${brief}`;
}

export class SubagentSessionRunner implements SubagentRunner {
	constructor(private readonly callbacks: SubagentRunnerCallbacks) {}

	start(state: SubagentState, opts: StartOptions): void {
		void this.spawnSession(state, opts);
	}

	respond(state: SubagentState, message: string): void {
		void this.runPromptCycle(state, message);
	}

	abort(state: SubagentState): void {
		state.session?.abortCompaction();
		state.session?.abort().catch(() => {});
	}

	private updateUsage(state: SubagentState, session: AgentSession): void {
		const stats = session.getSessionStats();
		state.inputTokens = stats.tokens.input;
		state.outputTokens = stats.tokens.output;
		state.cost = stats.cost;
	}

	private attachSessionListeners(state: SubagentState, session: AgentSession): void {
		state.unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				this.callbacks.onToolStart(state, {
					id: event.toolCallId,
					name: event.toolName,
					target: summarizeToolTarget(event.toolName, event.args),
				});
				return;
			}

			if (event.type === "tool_execution_end") {
				this.callbacks.onToolEnd(state, event.toolCallId, event.isError);
				return;
			}

			if (event.type === "turn_end") {
				const msg = event.message;
				if (msg.role === "assistant") {
					const assistant = msg as AssistantMessage;
					state.model = `${assistant.provider}/${assistant.model}`;
				}
				this.updateUsage(state, session);
				this.callbacks.onProgress(state.ownerSessionId);
				return;
			}

			if (event.type === "compaction_end") {
				this.updateUsage(state, session);
				this.callbacks.onProgress(state.ownerSessionId);
			}
		});
	}

	private attachSpawnedSession(state: SubagentState, session: AgentSession): boolean {
		if (!this.callbacks.isCurrent(state)) {
			session.dispose();
			return false;
		}
		state.session = session;
		state.model = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
		state.thinking = session.thinkingLevel;
		session.setSessionName(formatSubagentSessionName(state));
		return true;
	}

	private async runPromptCycle(state: SubagentState, prompt: string): Promise<void> {
		if (isAborted(state)) return;

		try {
			await state.session!.prompt(prompt);
			if (isAborted(state)) return;

			const outcome = getPromptOutcome(state);
			this.callbacks.onSettled(state, outcome.status, outcome);
		} catch (err) {
			if (isAborted(state)) return;
			const error = err instanceof Error ? err.message : String(err);
			this.callbacks.onSettled(state, "error", { error });
		}
	}

	private async spawnSession(state: SubagentState, opts: StartOptions): Promise<void> {
		try {
			if (isAborted(state)) return;

			const { session, warnings } = await bootstrapSession({
				agentConfig: state.agentConfig,
				cwd: opts.cwd,
				ctx: opts.ctx,
				extensionResolvedPath: opts.extensionResolvedPath,
			});

			for (const warning of warnings) opts.onWarning?.(warning);
			if (!this.attachSpawnedSession(state, session)) return;

			this.attachSessionListeners(state, session);
			await this.runPromptCycle(state, formatCrewTask(state.task));
		} catch (err) {
			if (isAborted(state)) return;
			if (state.status === "running") {
				const error = err instanceof Error ? err.message : String(err);
				this.callbacks.onSettled(state, "error", { error });
			}
		}
	}
}
