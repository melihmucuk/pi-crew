import { randomBytes } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./catalog.js";
import type { BootstrapContext, SubagentRunner, SubagentRunnerCallbacks } from "./subagent-session.js";
import type { CrewTask } from "./task.js";
import { SubagentSessionRunner } from "./subagent-session.js";
import {
	type SendMessageFn,
	type SteeringPayload,
	type SubagentStatus,
	sendSteeringMessage,
} from "./ui.js";

export interface ActiveRuntimeBinding {
	sessionId: string;
	isIdle: () => boolean;
	sendMessage: SendMessageFn;
}

interface PendingMessage {
	ownerSessionId: string;
	payload: SteeringPayload;
	queuedAt: number;
}

export type SubagentToolStatus = "running" | "done" | "error";

export interface SubagentToolActivity {
	id: string;
	name: string;
	target: string;
	status: SubagentToolStatus;
	resultSummary?: string;
}

export interface SubagentState {
	id: string;
	agentConfig: AgentConfig;
	task: CrewTask;
	brief: string;
	status: SubagentStatus;
	ownerSessionId: string;
	session: AgentSession | null;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	model: string | undefined;
	thinking: string | undefined;
	toolCallCount: number;
	toolFailureCount: number;
	activeToolCallIds: Set<string>;
	toolActivities: SubagentToolActivity[];
	startedAt: number;
	error?: string;
	result?: string;
	unsubscribe?: () => void;
}

export interface ActiveAgentSummary {
	id: string;
	agentName: string;
	brief?: string;
	status: SubagentStatus;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	model: string | undefined;
	thinking: string | undefined;
	toolCallCount: number;
	toolFailureCount: number;
	toolActivities: SubagentToolActivity[];
	startedAt: number;
}

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

type SettledSubagentStatus = Extract<SubagentStatus, "done" | "waiting" | "error" | "aborted">;

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
	return status === "running" || status === "waiting";
}

function buildActiveAgentSummary(state: SubagentState): ActiveAgentSummary {
	return {
		id: state.id,
		agentName: state.agentConfig.name,
		brief: state.brief,
		status: state.status,
		inputTokens: state.inputTokens,
		outputTokens: state.outputTokens,
		cost: state.cost,
		model: state.model,
		thinking: state.thinking,
		toolCallCount: state.toolCallCount,
		toolFailureCount: state.toolFailureCount,
		toolActivities: state.toolActivities.map((tool) => ({ ...tool })),
		startedAt: state.startedAt,
	};
}

/**
 * Process-global coordinator for subagent state, ownership, delivery, and cleanup.
 */
export class CrewRuntime {
	private readonly agents = new Map<string, SubagentState>();
	private readonly runner: SubagentRunner;
	private readonly refreshCallbacks = new Map<string, () => void>();
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
			isCurrent: (state) => this.agents.get(state.id) === state,
			onProgress: (ownerSessionId) => this.refreshWidgetFor(ownerSessionId),
			onToolStart: (state, tool) => this.startTool(state, tool),
			onToolEnd: (state, toolCallId, isError, resultSummary) => this.endTool(state, toolCallId, isError, resultSummary),
			onSettled: (state, status, outcome) => this.settleAgent(state, status, outcome),
		};
		this.runner = opts.createRunner?.(callbacks) ?? new SubagentSessionRunner(callbacks);
	}

	activateSession(binding: ActiveRuntimeBinding, refreshWidget?: () => void): void {
		if (refreshWidget) this.refreshCallbacks.set(binding.sessionId, refreshWidget);
		this.activeBinding = binding;
		this.schedulePendingFlushFor(binding.sessionId);
		refreshWidget?.();
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
		if (!state || !isAbortableStatus(state.status)) return false;

		this.runner.abort(state);
		this.settleAgent(state, "aborted", { error: opts.reason });
		return true;
	}

	abortOwned(ids: string[], callerSessionId: string, opts: AbortOptions): AbortOwnedResult {
		const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
		const result: AbortOwnedResult = { abortedIds: [], missingIds: [], foreignIds: [] };

		for (const id of uniqueIds) {
			const state = this.agents.get(id);
			if (!state || !isAbortableStatus(state.status)) {
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
			.filter((state) => state.ownerSessionId === callerSessionId && isAbortableStatus(state.status))
			.map((state) => state.id);
		for (const id of ids) this.abort(id, opts);
		return ids;
	}

	abortAll(): void {
		const allAgents = Array.from(this.agents.values()).filter((state) => isAbortableStatus(state.status));
		for (const state of allAgents) this.abort(state.id, { reason: "Aborted during shutdown" });
	}

	getActiveSummariesForOwner(ownerSessionId: string): ActiveAgentSummary[] {
		return Array.from(this.agents.values())
			.filter((state) => isAbortableStatus(state.status) && state.ownerSessionId === ownerSessionId)
			.map(buildActiveAgentSummary);
	}

	private createAgent(agentConfig: AgentConfig, task: CrewTask, brief: string, ownerSessionId: string): SubagentState {
		const id = generateId(agentConfig.name, new Set(this.agents.keys()));
		const state: SubagentState = {
			id,
			agentConfig,
			task,
			brief,
			status: "running",
			ownerSessionId,
			session: null,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: undefined,
			thinking: undefined,
			toolCallCount: 0,
			toolFailureCount: 0,
			activeToolCallIds: new Set(),
			toolActivities: [],
			startedAt: this.now(),
		};
		this.agents.set(id, state);
		return state;
	}

	private refreshWidgetFor(sessionId: string): void {
		this.refreshCallbacks.get(sessionId)?.();
	}

	private startTool(state: SubagentState, tool: Omit<SubagentToolActivity, "status">): void {
		if (this.agents.get(state.id) !== state) return;
		const activity: SubagentToolActivity = { ...tool, status: "running" };
		const existing = state.activeToolCallIds.has(tool.id);
		if (!existing) state.toolCallCount++;
		state.activeToolCallIds.add(tool.id);
		state.toolActivities = [
			...state.toolActivities.filter((candidate) => candidate.id !== tool.id),
			activity,
		].slice(-RETAINED_TOOL_ACTIVITY_LIMIT);
		this.refreshWidgetFor(state.ownerSessionId);
	}

	private endTool(state: SubagentState, toolCallId: string, isError: boolean, resultSummary?: string): void {
		if (this.agents.get(state.id) !== state || !state.activeToolCallIds.delete(toolCallId)) return;
		if (isError) state.toolFailureCount++;
		const tool = state.toolActivities.find((activity) => activity.id === toolCallId);
		if (!tool) return;
		tool.status = isError ? "error" : "done";
		if (!isError && resultSummary) tool.resultSummary = resultSummary;
		this.refreshWidgetFor(state.ownerSessionId);
	}

	private settleAgent(state: SubagentState, nextStatus: SettledSubagentStatus, opts: { result?: string; error?: string }): void {
		if (this.agents.get(state.id) !== state) return;

		state.status = nextStatus;
		state.result = opts.result;
		state.error = opts.error;

		this.deliver(state.ownerSessionId, {
			id: state.id,
			agentName: state.agentConfig.name,
			sessionFile: state.session?.sessionFile,
			status: state.status,
			result: state.result,
			error: state.error,
		});

		if (state.status !== "waiting") this.disposeAgent(state);
		else this.refreshWidgetFor(state.ownerSessionId);
	}

	private disposeAgent(state: SubagentState): void {
		state.unsubscribe?.();
		state.session?.dispose();
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
		if (owned.state.status !== "waiting") {
			return { ok: false, error: `Subagent "${id}" is not waiting for a response (status: ${owned.state.status})` };
		}
		if (!owned.state.session) return { ok: false, error: `Subagent "${id}" has no active session` };

		owned.state.status = "running";
		return owned;
	}

	private validateSubagentDone(id: string, callerSessionId: string): { ok: true; state: SubagentState } | { ok: false; error: string } {
		const owned = this.validateOwnedSubagent(id, callerSessionId, `No active subagent with id "${id}"`);
		if (!owned.ok) return owned;
		if (owned.state.status !== "waiting") return { ok: false, error: `Subagent "${id}" is not in waiting state` };
		return owned;
	}

	private countRunningForOwner(ownerSessionId: string, excludeId: string): number {
		let count = 0;
		for (const state of this.agents.values()) {
			if (state.id !== excludeId && state.ownerSessionId === ownerSessionId && state.status === "running") count++;
		}
		return count;
	}

	private schedulePendingFlushFor(sessionId: string): void {
		if (!this.pendingMessages.some((entry) => entry.ownerSessionId === sessionId)) return;

		this.flushScheduled = true;
		this.scheduleFlush(() => {
			this.flushScheduled = false;
			this.flushPending();
		});
	}

	private deliver(ownerSessionId: string, payload: SteeringPayload): void {
		if (!this.activeBinding || ownerSessionId !== this.activeBinding.sessionId || this.flushScheduled) {
			this.queue(ownerSessionId, payload);
			return;
		}
		this.send(ownerSessionId, payload);
	}

	private queue(ownerSessionId: string, payload: SteeringPayload): void {
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

	private send(ownerSessionId: string, payload: SteeringPayload): void {
		if (!this.activeBinding || this.activeBinding.sessionId !== ownerSessionId) {
			this.queue(ownerSessionId, payload);
			return;
		}

		const remaining = this.countRunningForOwner(ownerSessionId, payload.id);
		const isIdle = this.activeBinding.isIdle();
		const triggerResultTurn = payload.status === "waiting" || !(isIdle && remaining > 0);

		sendSteeringMessage(payload, this.activeBinding.sendMessage, { isIdle, triggerTurn: triggerResultTurn });
	}
}

const CREW_RUNTIME_VERSION = 3;
const crewRuntimeKey = Symbol.for("pi-crew.runtime");
const globalWithCrewRuntime = globalThis as typeof globalThis & Record<symbol, (CrewRuntime & { __piCrewRuntimeVersion?: number }) | undefined>;

function createCrewRuntime(): CrewRuntime & { __piCrewRuntimeVersion?: number } {
	const runtime = new CrewRuntime() as CrewRuntime & { __piCrewRuntimeVersion?: number };
	runtime.__piCrewRuntimeVersion = CREW_RUNTIME_VERSION;
	return runtime;
}

const existingRuntime = globalWithCrewRuntime[crewRuntimeKey];
export const crewRuntime = existingRuntime?.__piCrewRuntimeVersion === CREW_RUNTIME_VERSION
	? existingRuntime
	: (globalWithCrewRuntime[crewRuntimeKey] = createCrewRuntime());
