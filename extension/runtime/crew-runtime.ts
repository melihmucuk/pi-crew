import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { AgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../agent-discovery.js";
import type { BootstrapContext } from "../bootstrap-session.js";
import { bootstrapSession } from "../bootstrap-session.js";
import type { SubagentStatus } from "../subagent-messages.js";
import { type ActiveRuntimeBinding, DeliveryCoordinator } from "./delivery-coordinator.js";
import { runPromptWithOverflowRecovery } from "./overflow-recovery.js";
import { SubagentRegistry } from "./subagent-registry.js";
import {
	type AbortableAgentSummary,
	type ActiveAgentSummary,
	type SubagentState,
	isAbortableStatus,
	isAborted,
} from "./subagent-state.js";

export type {
	AbortableAgentSummary,
	ActiveAgentSummary,
} from "./subagent-state.js";

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
	parentSessionFile?: string;
	onWarning?: (message: string) => void;
}

function toBootstrapContext(ctx: SpawnContext): BootstrapContext {
	return {
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		parentSessionFile: ctx.parentSessionFile,
	};
}

interface PromptOutcome {
	status: Extract<SubagentStatus, "done" | "waiting" | "error" | "aborted">;
	result?: string;
	error?: string;
}

function getLastAssistantMessage(
	messages: AgentMessage[],
): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg as AssistantMessage;
		}
	}
	return undefined;
}

function getAssistantText(
	message: AssistantMessage | undefined,
): string | undefined {
	if (!message) return undefined;

	const texts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") {
			texts.push(part.text);
		}
	}

	return texts.length > 0 ? texts.join("\n") : undefined;
}

function getPromptOutcome(state: SubagentState): PromptOutcome {
	const lastAssistant = getLastAssistantMessage(state.session!.messages);
	const text = getAssistantText(lastAssistant);

	if (lastAssistant?.stopReason === "error") {
		return {
			status: "error",
			error: lastAssistant.errorMessage ?? text ?? "(no output)",
		};
	}

	if (lastAssistant?.stopReason === "aborted") {
		return {
			status: "aborted",
			error: lastAssistant.errorMessage ?? text ?? "(no output)",
		};
	}

	return {
		status: state.agentConfig.interactive ? "waiting" : "done",
		result: text ?? "(no output)",
	};
}

/**
 * Process-level singleton that owns all durable subagent state.
 *
 * This survives extension instance replacement caused by runtime
 * teardown/recreation on /resume, /new, /fork (pi 0.65.0+).
 * Each new extension instance rebinds delivery and widget hooks
 * via activateSession/deactivateSession.
 */
class CrewRuntime {
	private readonly registry = new SubagentRegistry();
	private readonly delivery = new DeliveryCoordinator();

	// Per-session refresh callbacks, keyed by ownerSessionId
	private readonly refreshCallbacks = new Map<string, () => void>();

	private refreshWidgetFor(sessionId: string): void {
		this.refreshCallbacks.get(sessionId)?.();
	}

	activateSession(
		binding: ActiveRuntimeBinding,
		refreshWidget?: () => void,
	): void {
		if (refreshWidget) {
			this.refreshCallbacks.set(binding.sessionId, refreshWidget);
		}
		this.delivery.activateSession(
			binding,
			(ownerSessionId, excludeId) =>
				this.registry.countRunningForOwner(ownerSessionId, excludeId),
		);
		refreshWidget?.();
	}

	deactivateSession(sessionId: string): void {
		this.delivery.deactivateSession(sessionId);
		this.refreshCallbacks.delete(sessionId);
	}

	spawn(
		agentConfig: AgentConfig,
		task: string,
		cwd: string,
		ownerSessionId: string,
		ctx: SpawnContext,
		extensionResolvedPath: string,
	): string {
		const state = this.registry.create(agentConfig, task, ownerSessionId);
		this.refreshWidgetFor(ownerSessionId);
		void this.spawnSession(
			state,
			cwd,
			ctx,
			extensionResolvedPath,
		);
		return state.id;
	}

	private attachSessionListeners(
		state: SubagentState,
		session: AgentSession,
	): void {
		state.unsubscribe = session.subscribe((event) => {
			if (event.type !== "turn_end") return;

			state.turns++;
			const msg = event.message;
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				state.contextTokens = assistantMsg.usage.totalTokens;
				state.model = assistantMsg.model;
			}
			this.refreshWidgetFor(state.ownerSessionId);
		});
	}

	private attachSpawnedSession(
		state: SubagentState,
		session: AgentSession,
	): boolean {
		if (!this.registry.hasState(state)) {
			session.dispose();
			return false;
		}

		state.session = session;
		return true;
	}

	private settleAgent(
		state: SubagentState,
		nextStatus: SubagentStatus,
		opts: { result?: string; error?: string },
	): void {
		state.status = nextStatus;
		state.result = opts.result;
		state.error = opts.error;

		this.delivery.deliver(
			state.ownerSessionId,
			{
				id: state.id,
				agentName: state.agentConfig.name,
				sessionFile: state.session?.sessionFile,
				status: state.status,
				result: state.result,
				error: state.error,
			},
			(ownerSessionId, excludeId) =>
				this.registry.countRunningForOwner(ownerSessionId, excludeId),
		);

		if (state.status !== "waiting") {
			this.disposeAgent(state);
		} else {
			this.refreshWidgetFor(state.ownerSessionId);
		}
	}

	private disposeAgent(state: SubagentState): void {
		state.unsubscribe?.();
		state.promptAbortController = undefined;
		state.session?.dispose();
		this.registry.delete(state.id);
		this.refreshWidgetFor(state.ownerSessionId);
	}

	private async runPromptCycle(
		state: SubagentState,
		prompt: string,
	): Promise<void> {
		if (isAborted(state)) return;

		const abortController = new AbortController();
		state.promptAbortController = abortController;

		try {
			const recovery = await runPromptWithOverflowRecovery(
				state.session!,
				prompt,
				abortController.signal,
			);
			if (isAborted(state)) return;

			const outcome = getPromptOutcome(state);

			if (recovery === "failed" && outcome.status !== "error") {
				this.settleAgent(state, "error", {
					error: "Context overflow recovery failed",
				});
				return;
			}

			this.settleAgent(state, outcome.status, outcome);
		} catch (err) {
			if (isAborted(state)) return;

			const error = err instanceof Error ? err.message : String(err);
			this.settleAgent(state, "error", { error });
		} finally {
			state.promptAbortController = undefined;
		}
	}

	private async spawnSession(
		state: SubagentState,
		cwd: string,
		ctx: SpawnContext,
		extensionResolvedPath: string,
	): Promise<void> {
		try {
			if (isAborted(state)) return;

			const { session, warnings } = await bootstrapSession({
				agentConfig: state.agentConfig,
				cwd,
				ctx: toBootstrapContext(ctx),
				extensionResolvedPath,
			});

			// Emit bootstrap warnings to UI
			for (const warning of warnings) {
				ctx.onWarning?.(warning);
			}

			if (!this.attachSpawnedSession(state, session)) return;

			this.attachSessionListeners(state, session);
			await this.runPromptCycle(state, state.task);
		} catch (err) {
			if (isAborted(state)) return;

			if (state.status === "running") {
				const error = err instanceof Error ? err.message : String(err);
				this.settleAgent(state, "error", { error });
			}
		}
	}

	respond(
		id: string,
		message: string,
		callerSessionId: string,
	): { error?: string } {
		const state = this.registry.get(id);
		if (!state) return { error: `No subagent with id "${id}"` };
		if (state.ownerSessionId !== callerSessionId) {
			return { error: `Subagent "${id}" belongs to a different session` };
		}
		if (state.status !== "waiting") {
			return {
				error: `Subagent "${id}" is not waiting for a response (status: ${state.status})`,
			};
		}
		if (!state.session)
			return { error: `Subagent "${id}" has no active session` };

		state.status = "running";
		this.refreshWidgetFor(state.ownerSessionId);
		void this.runPromptCycle(state, message);
		return {};
	}

	done(id: string, callerSessionId: string): { error?: string } {
		const state = this.registry.get(id);
		if (!state) return { error: `No active subagent with id "${id}"` };
		if (state.ownerSessionId !== callerSessionId) {
			return { error: `Subagent "${id}" belongs to a different session` };
		}
		if (state.status !== "waiting") {
			return { error: `Subagent "${id}" is not in waiting state` };
		}

		this.disposeAgent(state);
		return {};
	}

	abort(id: string, opts: AbortOptions): boolean {
		const state = this.registry.get(id);
		if (!state || !isAbortableStatus(state.status)) return false;

		state.promptAbortController?.abort();
		state.promptAbortController = undefined;
		state.session?.abortCompaction();
		state.session?.abortRetry();
		state.session?.abort().catch(() => {});
		this.settleAgent(state, "aborted", { error: opts.reason });
		return true;
	}

	abortOwned(
		ids: string[],
		callerSessionId: string,
		opts: AbortOptions,
	): AbortOwnedResult {
		const uniqueIds = Array.from(
			new Set(ids.map((id) => id.trim()).filter(Boolean)),
		);
		const result: AbortOwnedResult = {
			abortedIds: [],
			missingIds: [],
			foreignIds: [],
		};

		for (const id of uniqueIds) {
			const state = this.registry.get(id);
			if (!state || !isAbortableStatus(state.status)) {
				result.missingIds.push(id);
				continue;
			}
			if (state.ownerSessionId !== callerSessionId) {
				result.foreignIds.push(id);
				continue;
			}
			if (this.abort(id, opts)) {
				result.abortedIds.push(id);
			} else {
				result.missingIds.push(id);
			}
		}

		return result;
	}

	abortAllOwned(
		callerSessionId: string,
		opts: AbortOptions,
	): string[] {
		const ids = this.registry.getOwnedAbortableIds(callerSessionId);

		for (const id of ids) {
			this.abort(id, opts);
		}

		return ids;
	}

	/**
	 * Abort all running subagents (process-level cleanup).
	 * Called from process exit hooks.
	 */
	abortAll(): void {
		const allAgents = this.registry.getAllRunning();
		for (const state of allAgents) {
			this.abort(state.id, { reason: "Aborted on process exit" });
		}
	}

	getAbortableAgents(): AbortableAgentSummary[] {
		return this.registry.getAbortableAgents();
	}

	getActiveSummariesForOwner(ownerSessionId: string): ActiveAgentSummary[] {
		return this.registry.getActiveSummariesForOwner(ownerSessionId);
	}
}

export const crewRuntime = new CrewRuntime();
export type { CrewRuntime };
