import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	CredentialSynchronizationError,
	DefaultResourceLoader,
	ModelRuntime,
	type ModelRegistry,
	type ProviderConfig,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILT_IN_TOOL_NAMES, type AgentConfig } from "./catalog.js";
import type { SubagentState } from "./crew.js";
import {
	CREW_REPORT_CONTRACT_ERROR,
	CREW_REPORT_REMINDER,
	CREW_REPORT_TOOL_NAME,
	createCrewReportTool,
	findAcceptedReport,
	getLastAssistantMessage,
} from "./subagent-result.js";
import {
	SUBAGENT_STATUS,
	type SubagentSettlement,
	type SubagentToolActivity,
} from "./subagent-status.js";
import { formatCrewTask } from "./task.js";
import {
	summarizeToolName,
	summarizeToolRequest,
	summarizeToolResult,
	summarizeToolTarget,
} from "./tool-activity.js";

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
	signal: AbortSignal;
}

interface BootstrapResult {
	session: AgentSession;
	warnings: string[];
}

interface SubagentSessionRunnerOptions {
	bootstrap?: (opts: BootstrapOptions) => Promise<BootstrapResult>;
}

type PromptOutcome = SubagentSettlement;

interface StartOptions {
	cwd: string;
	ctx: BootstrapContext;
	extensionResolvedPath: string;
	onWarning?: (message: string) => void;
}

export interface SubagentSessionInfo {
	sessionFile?: string;
	model?: string;
	modelName?: string;
	thinking?: string;
}

export interface SubagentUsage {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	model?: string;
}

export interface SubagentRunnerCallbacks {
	onSessionAttached: (state: SubagentState, info: SubagentSessionInfo) => void;
	onUsage: (state: SubagentState, usage: SubagentUsage) => void;
	onToolStart: (state: SubagentState, tool: Omit<SubagentToolActivity, "status">) => void;
	onToolEnd: (state: SubagentState, toolCallId: string, isError: boolean, resultSummary?: string) => void;
	onSettled: (state: SubagentState, settlement: SubagentSettlement) => void;
}

export interface SubagentRunner {
	start(state: SubagentState, opts: StartOptions): void;
	respond(state: SubagentState, message: string): void;
	abort(state: SubagentState): void;
	dispose(state: SubagentState): void;
}

/** Per-state SDK handle; the runner is the only owner of these. */
interface SubagentHandle {
	bootstrapController?: AbortController;
	session?: AgentSession;
	unsubscribe?: () => void;
	aborted: boolean;
	/** Guards the one settlement a prompt cycle owes; a respond cycle clears it again. */
	settled: boolean;
}

function resolveTools(agentConfig: AgentConfig): string[] {
	return [...new Set([...(agentConfig.tools ?? BUILT_IN_TOOL_NAMES), CREW_REPORT_TOOL_NAME])];
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
	signal: AbortSignal,
): Promise<void> {
	const apiKey = await ownerRegistry.getApiKeyForProvider(providerId);
	if (!apiKey) {
		throw new Error(`Configured authentication for provider "${providerId}" cannot be transferred to the subagent runtime`);
	}
	try {
		await modelRuntime.setRuntimeApiKey(providerId, apiKey, { signal });
	} catch (error) {
		if (!(error instanceof CredentialSynchronizationError)) throw error;
		const cause = error.cause instanceof Error ? error.cause.message : error.cause ? String(error.cause) : undefined;
		throw new Error(
			`Authentication transfer for provider "${error.providerId}" was committed, but child runtime synchronization failed${cause ? `: ${cause}` : ""}`,
			{ cause: error },
		);
	}
}

async function createChildModelRuntime(
	agentConfig: AgentConfig,
	ctx: BootstrapContext,
	signal: AbortSignal,
): Promise<ModelRuntime> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(ctx.agentDir, "auth.json"),
		modelsPath: join(ctx.agentDir, "models.json"),
		allowModelNetwork: false,
		signal,
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
		if (ownerAuth.configured && (ownerAuth.source === "runtime" || !await modelRuntime.checkAuth(providerId, { signal }))) {
			await transferRuntimeApiKey(providerId, ctx.modelRegistry, modelRuntime, signal);
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
	const { agentConfig, cwd, ctx, extensionResolvedPath, signal } = opts;

	const modelRuntime = await createChildModelRuntime(agentConfig, ctx, signal);
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
	signal.throwIfAborted();
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
		customTools: [createCrewReportTool()],
		resourceLoader,
		sessionManager,
		settingsManager,
		modelRuntime,
	});

	return { session: result.session, warnings };
}

function getAssistantText(message: AssistantMessage | undefined): string | undefined {
	if (!message) return undefined;
	const texts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") texts.push(part.text);
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Returns undefined when the cycle ended normally without an accepted `crew_report` result. */
function getPromptOutcome(cycleMessages: AgentMessage[]): PromptOutcome | undefined {
	const lastAssistant = getLastAssistantMessage(cycleMessages);
	const text = getAssistantText(lastAssistant);

	if (lastAssistant?.stopReason === "error") {
		return { status: SUBAGENT_STATUS.error, error: lastAssistant.errorMessage ?? text ?? "(no output)" };
	}
	if (lastAssistant?.stopReason === "aborted") {
		return { status: SUBAGENT_STATUS.aborted, error: lastAssistant.errorMessage ?? text ?? "(no output)" };
	}

	const result = findAcceptedReport(cycleMessages);
	if (!result) return undefined;
	return result.outcome === SUBAGENT_STATUS.completed
		? { status: SUBAGENT_STATUS.completed, result }
		: { status: SUBAGENT_STATUS.needsInput, result };
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
	private readonly handles = new Map<SubagentState, SubagentHandle>();
	private readonly bootstrap: (opts: BootstrapOptions) => Promise<BootstrapResult>;

	constructor(
		private readonly callbacks: SubagentRunnerCallbacks,
		opts: SubagentSessionRunnerOptions = {},
	) {
		this.bootstrap = opts.bootstrap ?? bootstrapSession;
	}

	start(state: SubagentState, opts: StartOptions): void {
		const controller = new AbortController();
		const handle: SubagentHandle = { bootstrapController: controller, aborted: false, settled: false };
		this.handles.set(state, handle);
		void this.spawnSession(state, opts, handle, controller);
	}

	respond(state: SubagentState, message: string): void {
		const handle = this.handles.get(state) ?? { aborted: false, settled: false };
		if (!handle.session) {
			this.settle(state, handle, {
				status: SUBAGENT_STATUS.error,
				error: `Subagent "${state.id}" has no active session`,
			});
			return;
		}
		handle.settled = false;
		void this.runPromptCycle(state, message, handle, handle.session);
	}

	abort(state: SubagentState): void {
		const handle = this.handles.get(state);
		if (!handle) return;
		handle.aborted = true;
		handle.bootstrapController?.abort();
		handle.session?.abortCompaction();
		handle.session?.abort().catch(() => {});
	}

	dispose(state: SubagentState): void {
		const handle = this.handles.get(state);
		if (!handle) return;
		this.handles.delete(state);
		handle.unsubscribe?.();
		handle.session?.dispose();
	}

	/** Only settlement path: a prompt cycle settles once, and an aborted handle never settles. */
	private settle(state: SubagentState, handle: SubagentHandle, settlement: SubagentSettlement): void {
		if (handle.aborted || handle.settled) return;
		handle.settled = true;
		this.callbacks.onSettled(state, settlement);
	}

	private emitUsage(state: SubagentState, session: AgentSession, model?: string): void {
		const stats = session.getSessionStats();
		this.callbacks.onUsage(state, {
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cost: stats.cost,
			model,
		});
	}

	private attachSessionListeners(state: SubagentState, handle: SubagentHandle, session: AgentSession): void {
		handle.unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				this.callbacks.onToolStart(state, {
					id: event.toolCallId,
					name: summarizeToolName(event.toolName, event.args),
					target: summarizeToolTarget(event.toolName, event.args),
					resultSummary: summarizeToolRequest(event.toolName, event.args),
				});
				return;
			}

			if (event.type === "tool_execution_end") {
				this.callbacks.onToolEnd(state, event.toolCallId, event.isError, summarizeToolResult(event.toolName, event.result));
				return;
			}

			if (event.type === "turn_end") {
				const msg = event.message;
				const model = msg.role === "assistant"
					? `${(msg as AssistantMessage).provider}/${(msg as AssistantMessage).model}`
					: undefined;
				this.emitUsage(state, session, model);
				return;
			}

			if (event.type === "compaction_end") {
				this.emitUsage(state, session);
			}
		});
	}

	private attachSpawnedSession(state: SubagentState, handle: SubagentHandle, session: AgentSession): boolean {
		if (this.handles.get(state) !== handle || handle.aborted) {
			session.dispose();
			return false;
		}
		handle.session = session;
		session.setSessionName(formatSubagentSessionName(state));
		this.callbacks.onSessionAttached(state, {
			sessionFile: session.sessionFile,
			model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			modelName: session.model?.name,
			thinking: session.thinkingLevel,
		});
		return true;
	}

	private async runPromptCycle(
		state: SubagentState,
		prompt: string,
		handle: SubagentHandle,
		session: AgentSession,
	): Promise<void> {
		if (handle.aborted) return;

		try {
			const start = session.messages.length;
			await session.prompt(prompt);
			if (handle.aborted) return;

			let outcome = getPromptOutcome(session.messages.slice(start));
			if (!outcome) {
				await session.prompt(CREW_REPORT_REMINDER);
				if (handle.aborted) return;
				outcome = getPromptOutcome(session.messages.slice(start))
					?? { status: SUBAGENT_STATUS.error, error: CREW_REPORT_CONTRACT_ERROR };
			}
			this.settle(state, handle, outcome);
		} catch (err) {
			if (handle.aborted) return;
			const error = err instanceof Error ? err.message : String(err);
			this.settle(state, handle, { status: SUBAGENT_STATUS.error, error });
		}
	}

	private async spawnSession(
		state: SubagentState,
		opts: StartOptions,
		handle: SubagentHandle,
		bootstrapController: AbortController,
	): Promise<void> {
		try {
			if (handle.aborted) return;

			let bootstrapResult: BootstrapResult;
			try {
				bootstrapResult = await this.bootstrap({
					agentConfig: state.agentConfig,
					cwd: opts.cwd,
					ctx: opts.ctx,
					extensionResolvedPath: opts.extensionResolvedPath,
					signal: bootstrapController.signal,
				});
			} finally {
				handle.bootstrapController = undefined;
			}
			const { session, warnings } = bootstrapResult;

			for (const warning of warnings) opts.onWarning?.(warning);
			if (!this.attachSpawnedSession(state, handle, session)) return;

			this.attachSessionListeners(state, handle, session);
			await this.runPromptCycle(state, formatCrewTask(state.task), handle, session);
		} catch (err) {
			if (handle.aborted) return;
			const error = err instanceof Error ? err.message : String(err);
			this.settle(state, handle, { status: SUBAGENT_STATUS.error, error });
		}
	}
}
