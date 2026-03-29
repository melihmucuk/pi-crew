import { randomBytes } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { bootstrapSession } from "./session-factory.js";
import { type SteeringPayload, type SubagentStatus, sendRemainingNote, sendSteeringMessage } from "./steering.js";

interface SubagentState {
	id: string;
	agentConfig: AgentConfig;
	task: string;
	status: SubagentStatus;
	ownerSessionId: string;
	session: AgentSession | null;
	turns: number;
	contextTokens: number;
	model: string | undefined;
	error?: string;
	result?: string;
}

export interface ActiveAgentSummary {
	id: string;
	agentName: string;
	status: SubagentStatus;
	taskPreview: string;
	turns: number;
	contextTokens: number;
	model: string | undefined;
}

export interface AbortableAgentSummary {
	id: string;
	agentName: string;
}

function generateId(name: string, existingIds: Set<string>): string {
	for (let i = 0; i < 10; i++) {
		const id = `${name}-${randomBytes(4).toString("hex")}`;
		if (!existingIds.has(id)) return id;
	}
	return `${name}-${randomBytes(8).toString("hex")}`;
}

// Status may change externally via abort(). Standalone function avoids TS narrowing.
function isAborted(state: SubagentState): boolean {
	return state.status === "aborted";
}

function extractLastAssistantText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const texts: string[] = [];
			for (const part of assistantMsg.content) {
				if (part.type === "text") {
					texts.push(part.text);
				}
			}
			if (texts.length > 0) return texts.join("\n");
		}
	}
	return undefined;
}

function buildActiveAgentSummary(state: SubagentState): ActiveAgentSummary {
	const taskPreview = state.task.length > 80 ? `${state.task.slice(0, 80)}...` : state.task;
	return {
		id: state.id,
		agentName: state.agentConfig.name,
		status: state.status,
		taskPreview,
		turns: state.turns,
		contextTokens: state.contextTokens,
		model: state.model,
	};
}

function buildAbortableAgentSummary(state: SubagentState): AbortableAgentSummary {
	return {
		id: state.id,
		agentName: state.agentConfig.name,
	};
}

export class CrewManager {
	private activeAgents = new Map<string, SubagentState>();
	private extensionResolvedPath: string;
	private currentSessionId: string | undefined;
	private currentIsIdle: () => boolean = () => true;
	private pendingMessages: { ownerSessionId: string; payload: SteeringPayload }[] = [];

	onWidgetUpdate: (() => void) | undefined;

	constructor(extensionResolvedPath: string) {
		this.extensionResolvedPath = extensionResolvedPath;
	}

	activateSession(sessionId: string, isIdle: () => boolean, pi: ExtensionAPI): void {
		this.currentSessionId = sessionId;
		this.currentIsIdle = isIdle;
		this.flushPending(pi);
	}

	private flushPending(pi: ExtensionAPI): void {
		const toDeliver: typeof this.pendingMessages = [];
		const remaining: typeof this.pendingMessages = [];

		for (const entry of this.pendingMessages) {
			if (entry.ownerSessionId === this.currentSessionId) {
				toDeliver.push(entry);
			} else {
				remaining.push(entry);
			}
		}

		this.pendingMessages = remaining;
		for (const entry of toDeliver) {
			this.deliverPayload(entry.ownerSessionId, entry.payload, pi);
		}
	}

	spawn(
		agentConfig: AgentConfig,
		task: string,
		cwd: string,
		ownerSessionId: string,
		ctx: ExtensionContext,
		pi: ExtensionAPI,
	): string {
		const existingIds = new Set(this.activeAgents.keys());
		const id = generateId(agentConfig.name, existingIds);
		const state: SubagentState = {
			id,
			agentConfig,
			task,
			status: "running",
			ownerSessionId,
			session: null,
			turns: 0,
			contextTokens: 0,
			model: undefined,
		};

		this.activeAgents.set(id, state);
		this.onWidgetUpdate?.();
		void this.spawnSession(state, cwd, ctx.sessionManager.getSessionFile(), ctx, pi);

		return id;
	}

	private attachSessionListeners(state: SubagentState, session: AgentSession): void {
		session.subscribe((event) => {
			if (event.type !== "turn_end") return;

			state.turns++;
			const msg = event.message;
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				state.contextTokens = assistantMsg.usage.totalTokens;
				state.model = assistantMsg.model;
			}
			this.onWidgetUpdate?.();
		});
	}

	private attachSpawnedSession(state: SubagentState, session: AgentSession): boolean {
		if (this.activeAgents.get(state.id) !== state) {
			session.dispose();
			return false;
		}

		state.session = session;
		return true;
	}

	private countRunningForOwner(ownerSessionId: string, excludeId: string): number {
		let count = 0;
		for (const state of this.activeAgents.values()) {
			if (
				state.id !== excludeId &&
				state.ownerSessionId === ownerSessionId &&
				state.status === "running"
			) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Delivers a payload to the owner session if active, otherwise queues it.
	 * When the owner session is idle, inject the hidden remaining-count note first
	 * so the triggered turn sees both pieces of context.
	 */
	private deliverPayload(ownerSessionId: string, payload: SteeringPayload, pi: ExtensionAPI): void {
		if (ownerSessionId !== this.currentSessionId) {
			this.pendingMessages.push({ ownerSessionId, payload });
			return;
		}

		const remaining = this.countRunningForOwner(ownerSessionId, payload.id);
		const isIdle = this.currentIsIdle();

		sendSteeringMessage(payload, pi, isIdle);
		sendRemainingNote(remaining, pi, { isIdle, triggerTurn: false });
	}

	/**
	 * Single owner for post-prompt and terminal state transitions.
	 * Publishes the outcome, updates state, and disposes finished agents.
	 */
	private settleAgent(
		state: SubagentState,
		nextStatus: SubagentStatus,
		opts: { result?: string; error?: string },
		pi: ExtensionAPI,
	): void {
		state.status = nextStatus;
		state.result = opts.result;
		state.error = opts.error;

		this.deliverPayload(state.ownerSessionId, {
			id: state.id,
			agentName: state.agentConfig.name,
			status: state.status,
			result: state.result,
			error: state.error,
		}, pi);

		if (state.status !== "waiting") {
			this.disposeAgent(state);
		} else {
			this.onWidgetUpdate?.();
		}
	}

	private disposeAgent(state: SubagentState): void {
		state.session?.dispose();
		this.activeAgents.delete(state.id);
		this.onWidgetUpdate?.();
	}

	private async runPromptCycle(
		state: SubagentState,
		prompt: string,
		pi: ExtensionAPI,
	): Promise<void> {
		if (isAborted(state)) return;

		try {
			await state.session!.prompt(prompt);
			if (isAborted(state)) return;

			const result = extractLastAssistantText(state.session!.messages) ?? "(no output)";
			const nextStatus = state.agentConfig.interactive ? "waiting" : "done";
			this.settleAgent(state, nextStatus, { result }, pi);
		} catch (err) {
			if (isAborted(state)) return;

			const error = err instanceof Error ? err.message : String(err);
			this.settleAgent(state, "error", { error }, pi);
		}
	}

	private async spawnSession(
		state: SubagentState,
		cwd: string,
		parentSessionFile: string | undefined,
		ctx: ExtensionContext,
		pi: ExtensionAPI,
	): Promise<void> {
		try {
			if (isAborted(state)) return;

			const { session } = await bootstrapSession({
				agentConfig: state.agentConfig,
				cwd,
				ctx,
				extensionResolvedPath: this.extensionResolvedPath,
				parentSessionFile,
			});

			if (!this.attachSpawnedSession(state, session)) return;

			this.attachSessionListeners(state, session);
			await this.runPromptCycle(state, state.task, pi);
		} catch (err) {
			if (isAborted(state)) return;

			// Only bootstrap errors reach here; runPromptCycle handles its own errors
			if (state.status === "running") {
				const error = err instanceof Error ? err.message : String(err);
				this.settleAgent(state, "error", { error }, pi);
			}
		}
	}

	respond(
		id: string,
		message: string,
		pi: ExtensionAPI,
		callerSessionId: string,
	): { error?: string } {
		const state = this.activeAgents.get(id);
		if (!state) return { error: `No agent with id "${id}"` };
		if (state.ownerSessionId !== callerSessionId) {
			return { error: `Agent "${id}" belongs to a different session` };
		}
		if (state.status !== "waiting") {
			return { error: `Agent "${id}" is not waiting for a response (status: ${state.status})` };
		}
		if (!state.session) return { error: `Agent "${id}" has no active session` };

		state.status = "running";
		this.onWidgetUpdate?.();
		void this.runPromptCycle(state, message, pi);
		return {};
	}

	done(id: string, callerSessionId: string): { error?: string } {
		const state = this.activeAgents.get(id);
		if (!state) return { error: `No active agent with id "${id}"` };
		if (state.ownerSessionId !== callerSessionId) {
			return { error: `Agent "${id}" belongs to a different session` };
		}
		if (state.status !== "waiting") {
			return { error: `Agent "${id}" is not in waiting state` };
		}

		this.disposeAgent(state);
		return {};
	}

	abort(id: string, pi: ExtensionAPI): boolean {
		const state = this.activeAgents.get(id);
		if (!state) return false;

		state.session?.abort().catch(() => {});
		this.settleAgent(state, "aborted", { error: "Aborted by user" }, pi);
		return true;
	}

	abortForOwner(ownerSessionId: string, pi: ExtensionAPI): void {
		for (const [id, state] of this.activeAgents) {
			if (state.ownerSessionId === ownerSessionId) {
				this.abort(id, pi);
			}
		}
		this.pendingMessages = this.pendingMessages.filter(
			(entry) => entry.ownerSessionId !== ownerSessionId,
		);
	}

	getAbortableAgents(): AbortableAgentSummary[] {
		return Array.from(this.activeAgents.values())
			.filter((state) => state.status === "running" || state.status === "waiting")
			.map(buildAbortableAgentSummary);
	}

	getActiveSummariesForOwner(ownerSessionId: string): ActiveAgentSummary[] {
		return Array.from(this.activeAgents.values())
			.filter(
				(state) =>
					(state.status === "running" || state.status === "waiting") &&
					state.ownerSessionId === ownerSessionId,
			)
			.map(buildActiveAgentSummary);
	}
}
