import { randomBytes } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./catalog.js";
import type {
	BootstrapContext,
	SubagentRunner,
	SubagentRunnerCallbacks,
	SubagentSessionInfo,
	SubagentUsage,
} from "./subagent-session.js";
import { CREW_REPORT_TOOL_NAME } from "./subagent-result.js";
import {
	SUBAGENT_STATUS,
	SUBAGENT_TOOL_STATUS,
	isSubagentStatusPhase,
	type SubagentLifecycle,
	type SubagentSettlement,
	type SubagentStatus,
	type SubagentToolActivity,
} from "./subagent-status.js";
import type { CrewTask } from "./task.js";
import { SubagentSessionRunner } from "./subagent-session.js";
import {
	type AppendEntryFn,
	type CrewResultPayload,
	type SendMessageFn,
	appendCrewAbortEntry,
	sendCrewResultMessage,
} from "./delivery.js";

export interface ActiveRuntimeBinding {
	sessionId: string;
	/** Session file of the owner session; used only to re-parent subagents across a fork. */
	sessionFile?: string;
	sendMessage: SendMessageFn;
	appendEntry: AppendEntryFn;
}

interface PendingMessage {
	ownerSessionId: string;
	payload: CrewResultPayload;
	queuedAt: number;
}

export interface SubagentState {
	id: string;
	agentConfig: AgentConfig;
	task: CrewTask;
	brief: string;
	lifecycle: SubagentLifecycle;
	ownerSessionId: string;
	/** Session file of the attached SDK session; the runner owns the session itself. */
	sessionFile: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	model: string | undefined;
	/** Catalog display name of the resolved model, when the provider knows one. */
	modelName: string | undefined;
	thinking: string | undefined;
	toolCallCount: number;
	toolFailureCount: number;
	activeToolCallIds: Set<string>;
	toolActivities: SubagentToolActivity[];
	/** Milliseconds spent in prompt cycles, excluding waiting for owner actions. */
	workedMs: number;
	/** Start of the current cycle, absent while awaiting an owner action. */
	runningSince: number | undefined;
}

interface ActiveAgentSummaryBase {
	id: string;
	agentName: string;
	brief?: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	model: string | undefined;
	modelName: string | undefined;
	thinking: string | undefined;
	toolCallCount: number;
	toolFailureCount: number;
	toolActivities: SubagentToolActivity[];
	workedMs: number;
}

export type ActiveAgentSummary = ActiveAgentSummaryBase & SubagentLifecycle;

export interface AbortOwnedResult {
	abortedIds: string[];
	missingIds: string[];
	foreignIds: string[];
}

interface AbortOptions {
	reason: string;
}

export interface SpawnContext {
	model: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	agentDir: string;
	parentSessionFile?: string;
	onWarning?: (message: string) => void;
	brief?: string;
}

const PENDING_MESSAGE_TTL_MS = 86_400_000;
const RETAINED_TOOL_ACTIVITY_LIMIT = 10;

function toBootstrapContext(ctx: SpawnContext): BootstrapContext {
	return {
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		agentDir: ctx.agentDir,
		parentSessionFile: ctx.parentSessionFile,
	};
}

function generateId(name: string, existingIds: Set<string>): string {
	for (let i = 0; i < 10; i++) {
		const id = `${name}-${randomBytes(4).toString("hex")}`;
		if (!existingIds.has(id)) return id;
	}
	return `${name}-${randomBytes(8).toString("hex")}`;
}

function isAbortableStatus(status: SubagentStatus): boolean {
	return !isSubagentStatusPhase(status, "terminal");
}

function buildActiveAgentSummary(state: SubagentState, now: number): ActiveAgentSummary {
	return {
		id: state.id,
		agentName: state.agentConfig.name,
		brief: state.brief,
		...state.lifecycle,
		inputTokens: state.inputTokens,
		outputTokens: state.outputTokens,
		cost: state.cost,
		model: state.model,
		modelName: state.modelName,
		thinking: state.thinking,
		toolCallCount: state.toolCallCount,
		toolFailureCount: state.toolFailureCount,
		toolActivities: state.toolActivities.map((tool) => ({ ...tool })),
		workedMs: state.workedMs + (state.runningSince === undefined ? 0 : Math.max(0, now - state.runningSince)),
	};
}

/**
 * Process-global coordinator for subagent state, ownership, delivery, and cleanup.
 */
export class CrewRuntime {
	private readonly agents = new Map<string, SubagentState>();
	private readonly runner: SubagentRunner;
	private readonly refreshCallbacks = new Map<string, () => void>();
	private readonly runningCountListeners = new Set<(count: number) => void>();
	/** Owner session file → session id, so a fork can find the session it replaced. */
	private readonly sessionIdsByFile = new Map<string, string>();
	private activeBinding: ActiveRuntimeBinding | undefined;
	private pendingMessages: PendingMessage[] = [];
	private flushScheduled = false;
	private readonly now: () => number;
	private readonly scheduleFlush: (callback: () => void) => void;

	constructor(opts: {
		now?: () => number;
		scheduleFlush?: (callback: () => void) => void;
		createRunner?: (callbacks: SubagentRunnerCallbacks) => SubagentRunner;
	} = {}) {
		this.now = opts.now ?? Date.now;
		this.scheduleFlush = opts.scheduleFlush ?? ((callback) => setTimeout(callback, 0));
		const callbacks: SubagentRunnerCallbacks = {
			onSessionAttached: (state, info) => this.attachSession(state, info),
			onUsage: (state, usage) => this.updateUsage(state, usage),
			onToolStart: (state, tool) => this.startTool(state, tool),
			onToolEnd: (state, toolCallId, isError, resultSummary) => this.endTool(state, toolCallId, isError, resultSummary),
			onSettled: (state, settlement) => this.settleAgent(state, settlement),
		};
		this.runner = opts.createRunner?.(callbacks) ?? new SubagentSessionRunner(callbacks);
	}

	activateSession(binding: ActiveRuntimeBinding, refreshWidget?: () => void): void {
		if (refreshWidget) this.refreshCallbacks.set(binding.sessionId, refreshWidget);
		if (binding.sessionFile !== undefined) this.sessionIdsByFile.set(binding.sessionFile, binding.sessionId);
		this.activeBinding = binding;
		this.schedulePendingFlushFor(binding.sessionId);
		refreshWidget?.();
	}

	/**
	 * Re-parents the forked session's live subagents and queued results to the new session id.
	 * Returns the adopted subagent ids.
	 */
	adoptSession(previousSessionFile: string, newSessionId: string): string[] {
		const previousSessionId = this.sessionIdsByFile.get(previousSessionFile);
		if (previousSessionId === undefined || previousSessionId === newSessionId) return [];

		const adoptedIds: string[] = [];
		for (const state of this.agents.values()) {
			if (state.ownerSessionId !== previousSessionId || !isAbortableStatus(state.lifecycle.status)) continue;
			state.ownerSessionId = newSessionId;
			adoptedIds.push(state.id);
		}
		for (const entry of this.pendingMessages) {
			if (entry.ownerSessionId === previousSessionId) entry.ownerSessionId = newSessionId;
		}
		return adoptedIds;
	}

	deactivateSession(sessionId: string): void {
		if (this.activeBinding?.sessionId === sessionId) this.activeBinding = undefined;
		this.refreshCallbacks.delete(sessionId);
	}

	spawn(
		agentConfig: AgentConfig,
		task: CrewTask,
		cwd: string,
		ownerSessionId: string,
		ctx: SpawnContext,
		extensionResolvedPath: string,
	): string {
		const state = this.createAgent(agentConfig, task, ctx.brief ?? "", ownerSessionId);
		this.publishRunningCount();
		this.refreshWidgetFor(ownerSessionId);
		this.runner.start(state, {
			cwd,
			ctx: toBootstrapContext(ctx),
			extensionResolvedPath,
			onWarning: ctx.onWarning,
		});
		return state.id;
	}

	respond(id: string, message: string, callerSessionId: string): { error?: string } {
		const transition = this.startSubagentResponse(id, callerSessionId);
		if (!transition.ok) return { error: transition.error };

		this.publishRunningCount();
		this.refreshWidgetFor(transition.state.ownerSessionId);
		this.runner.respond(transition.state, message);
		return {};
	}

	done(id: string, callerSessionId: string): { error?: string } {
		const transition = this.validateSubagentDone(id, callerSessionId);
		if (!transition.ok) return { error: transition.error };

		this.disposeAgent(transition.state);
		return {};
	}

	abort(id: string, opts: AbortOptions): boolean {
		const state = this.agents.get(id);
		if (!state || !isAbortableStatus(state.lifecycle.status)) return false;

		this.runner.abort(state);
		this.settleAgent(state, { status: SUBAGENT_STATUS.aborted, error: opts.reason });
		return true;
	}

	abortOwned(ids: string[], callerSessionId: string, opts: AbortOptions): AbortOwnedResult {
		const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
		const result: AbortOwnedResult = { abortedIds: [], missingIds: [], foreignIds: [] };

		for (const id of uniqueIds) {
			const state = this.agents.get(id);
			if (!state || !isAbortableStatus(state.lifecycle.status)) {
				result.missingIds.push(id);
				continue;
			}
			if (state.ownerSessionId !== callerSessionId) {
				result.foreignIds.push(id);
				continue;
			}
			if (this.abort(id, opts)) result.abortedIds.push(id);
			else result.missingIds.push(id);
		}

		return result;
	}

	abortAllOwned(callerSessionId: string, opts: AbortOptions): string[] {
		const ids = Array.from(this.agents.values())
			.filter((state) => state.ownerSessionId === callerSessionId && isAbortableStatus(state.lifecycle.status))
			.map((state) => state.id);
		for (const id of ids) this.abort(id, opts);
		return ids;
	}

	abortAll(): void {
		const allAgents = Array.from(this.agents.values()).filter((state) => isAbortableStatus(state.lifecycle.status));
		for (const state of allAgents) this.abort(state.id, { reason: "Aborted during shutdown" });
	}

	/** Pane-level observers include work preserved across owner-session switches. */
	observeRunningCount(listener: (count: number) => void): () => void {
		this.runningCountListeners.add(listener);
		listener(this.getRunningCount());
		return () => { this.runningCountListeners.delete(listener); };
	}

	private getRunningCount(): number {
		let count = 0;
		for (const state of this.agents.values()) {
			if (isSubagentStatusPhase(state.lifecycle.status, "in-flight")) count++;
		}
		return count;
	}

	private publishRunningCount(): void {
		if (this.runningCountListeners.size === 0) return;
		const count = this.getRunningCount();
		for (const listener of this.runningCountListeners) listener(count);
	}

	getActiveSummariesForOwner(ownerSessionId: string): ActiveAgentSummary[] {
		return Array.from(this.agents.values())
			.filter((state) => isAbortableStatus(state.lifecycle.status) && state.ownerSessionId === ownerSessionId)
			.map((state) => buildActiveAgentSummary(state, this.now()));
	}

	private createAgent(agentConfig: AgentConfig, task: CrewTask, brief: string, ownerSessionId: string): SubagentState {
		const id = generateId(agentConfig.name, new Set(this.agents.keys()));
		const state: SubagentState = {
			id,
			agentConfig,
			task,
			brief,
			lifecycle: { status: SUBAGENT_STATUS.running },
			ownerSessionId,
			sessionFile: undefined,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: undefined,
			modelName: undefined,
			thinking: undefined,
			toolCallCount: 0,
			toolFailureCount: 0,
			activeToolCallIds: new Set(),
			toolActivities: [],
			workedMs: 0,
			runningSince: this.now(),
		};
		this.agents.set(id, state);
		return state;
	}

	private refreshWidgetFor(sessionId: string): void {
		this.refreshCallbacks.get(sessionId)?.();
	}

	private attachSession(state: SubagentState, info: SubagentSessionInfo): void {
		if (this.agents.get(state.id) !== state) return;
		state.sessionFile = info.sessionFile;
		state.model = info.model;
		state.modelName = info.modelName;
		state.thinking = info.thinking;
	}

	private updateUsage(state: SubagentState, usage: SubagentUsage): void {
		if (this.agents.get(state.id) !== state) return;
		state.inputTokens = usage.inputTokens;
		state.outputTokens = usage.outputTokens;
		state.cost = usage.cost;
		if (usage.model !== undefined) state.model = usage.model;
		this.refreshWidgetFor(state.ownerSessionId);
	}

	private startTool(state: SubagentState, tool: Omit<SubagentToolActivity, "status">): void {
		if (this.agents.get(state.id) !== state) return;
		const existing = state.activeToolCallIds.has(tool.id);
		if (!existing) state.toolCallCount++;
		state.activeToolCallIds.add(tool.id);
		// `crew_report` is protocol mechanics: it drives the lifecycle status and the result card,
		// so it counts as a tool call but never occupies a retained activity row.
		if (tool.name !== CREW_REPORT_TOOL_NAME) {
			const activity: SubagentToolActivity = { ...tool, status: SUBAGENT_TOOL_STATUS.running };
			state.toolActivities = [
				...state.toolActivities.filter((candidate) => candidate.id !== tool.id),
				activity,
			].slice(-RETAINED_TOOL_ACTIVITY_LIMIT);
		}
		this.refreshWidgetFor(state.ownerSessionId);
	}

	private endTool(state: SubagentState, toolCallId: string, isError: boolean, resultSummary?: string): void {
		if (this.agents.get(state.id) !== state || !state.activeToolCallIds.delete(toolCallId)) return;
		if (isError) state.toolFailureCount++;
		const tool = state.toolActivities.find((activity) => activity.id === toolCallId);
		if (!tool) return;
		tool.status = isError ? SUBAGENT_TOOL_STATUS.error : SUBAGENT_TOOL_STATUS.done;
		if (!isError && resultSummary) tool.resultSummary = resultSummary;
		this.refreshWidgetFor(state.ownerSessionId);
	}

	private settleAgent(state: SubagentState, settlement: SubagentSettlement): void {
		if (this.agents.get(state.id) !== state) return;

		if (state.runningSince !== undefined) {
			state.workedMs += Math.max(0, this.now() - state.runningSince);
			state.runningSince = undefined;
		}
		state.lifecycle = settlement;
		this.publishRunningCount();

		this.deliver(state.ownerSessionId, {
			id: state.id,
			agentName: state.agentConfig.name,
			brief: state.brief || undefined,
			sessionFile: state.sessionFile,
			settlement,
		});

		if (isSubagentStatusPhase(settlement.status, "terminal")) this.disposeAgent(state);
		else this.refreshWidgetFor(state.ownerSessionId);
	}

	private disposeAgent(state: SubagentState): void {
		this.runner.dispose(state);
		this.agents.delete(state.id);
		this.refreshWidgetFor(state.ownerSessionId);
	}

	private validateOwnedSubagent(
		id: string,
		callerSessionId: string,
		missingMessage: string,
	): { ok: true; state: SubagentState } | { ok: false; error: string } {
		const state = this.agents.get(id);
		if (!state) return { ok: false, error: missingMessage };
		if (state.ownerSessionId !== callerSessionId) {
			return { ok: false, error: `Subagent "${id}" belongs to a different session` };
		}
		return { ok: true, state };
	}

	private startSubagentResponse(id: string, callerSessionId: string): { ok: true; state: SubagentState } | { ok: false; error: string } {
		const owned = this.validateOwnedSubagent(id, callerSessionId, `No subagent with id "${id}"`);
		if (!owned.ok) return owned;
		if (!isSubagentStatusPhase(owned.state.lifecycle.status, "awaiting-owner")) {
			return { ok: false, error: `Subagent "${id}" is not awaiting an owner action (status: ${owned.state.lifecycle.status})` };
		}
		owned.state.lifecycle = { status: SUBAGENT_STATUS.running };
		owned.state.runningSince = this.now();
		return owned;
	}

	private validateSubagentDone(id: string, callerSessionId: string): { ok: true; state: SubagentState } | { ok: false; error: string } {
		const owned = this.validateOwnedSubagent(id, callerSessionId, `No active subagent with id "${id}"`);
		if (!owned.ok) return owned;
		if (!isSubagentStatusPhase(owned.state.lifecycle.status, "awaiting-owner")) {
			return { ok: false, error: `Subagent "${id}" is not awaiting an owner action (status: ${owned.state.lifecycle.status})` };
		}
		return owned;
	}

	private schedulePendingFlushFor(sessionId: string): void {
		if (!this.pendingMessages.some((entry) => entry.ownerSessionId === sessionId)) return;

		this.flushScheduled = true;
		this.scheduleFlush(() => {
			this.flushScheduled = false;
			this.flushPending();
		});
	}

	private deliver(ownerSessionId: string, payload: CrewResultPayload): void {
		if (!this.activeBinding || ownerSessionId !== this.activeBinding.sessionId || this.flushScheduled) {
			this.queue(ownerSessionId, payload);
			return;
		}
		this.send(ownerSessionId, payload);
	}

	private queue(ownerSessionId: string, payload: CrewResultPayload): void {
		this.pendingMessages.push({ ownerSessionId, payload, queuedAt: this.now() });
	}

	private cleanStaleMessages(): void {
		const cutoff = this.now() - PENDING_MESSAGE_TTL_MS;
		this.pendingMessages = this.pendingMessages.filter((entry) => entry.queuedAt >= cutoff);
	}

	private flushPending(): void {
		if (!this.activeBinding) return;
		const targetSessionId = this.activeBinding.sessionId;
		this.cleanStaleMessages();

		const toDeliver: PendingMessage[] = [];
		const remaining: PendingMessage[] = [];
		for (const entry of this.pendingMessages) {
			if (entry.ownerSessionId === targetSessionId) toDeliver.push(entry);
			else remaining.push(entry);
		}
		this.pendingMessages = remaining;

		for (const entry of toDeliver) this.send(entry.ownerSessionId, entry.payload);
	}

	private send(ownerSessionId: string, payload: CrewResultPayload): void {
		if (!this.activeBinding || this.activeBinding.sessionId !== ownerSessionId) {
			this.queue(ownerSessionId, payload);
			return;
		}

		if (payload.settlement.status === SUBAGENT_STATUS.aborted) {
			appendCrewAbortEntry(payload, this.activeBinding.appendEntry);
			return;
		}
		sendCrewResultMessage(payload, this.activeBinding.sendMessage);
	}
}

/** Bump whenever `CrewRuntime`'s public API or the `SubagentState` shape changes; a mismatch aborts the stale runtime's subagents. */
const CREW_RUNTIME_VERSION = 9;
const crewRuntimeKey = Symbol.for("pi-crew.runtime");
const globalWithCrewRuntime = globalThis as typeof globalThis & Record<symbol, (CrewRuntime & { __piCrewRuntimeVersion?: number }) | undefined>;

function createCrewRuntime(): CrewRuntime & { __piCrewRuntimeVersion?: number } {
	const runtime = new CrewRuntime() as CrewRuntime & { __piCrewRuntimeVersion?: number };
	runtime.__piCrewRuntimeVersion = CREW_RUNTIME_VERSION;
	return runtime;
}

function replaceStaleRuntime(existing: CrewRuntime & { __piCrewRuntimeVersion?: number }): CrewRuntime & { __piCrewRuntimeVersion?: number } {
	if (typeof existing.abortAll === "function") existing.abortAll();
	return (globalWithCrewRuntime[crewRuntimeKey] = createCrewRuntime());
}

const existingRuntime = globalWithCrewRuntime[crewRuntimeKey];
export const crewRuntime = !existingRuntime
	? (globalWithCrewRuntime[crewRuntimeKey] = createCrewRuntime())
	: existingRuntime.__piCrewRuntimeVersion === CREW_RUNTIME_VERSION
		? existingRuntime
		: replaceStaleRuntime(existingRuntime);
