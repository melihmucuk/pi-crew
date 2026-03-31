import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agent-discovery.js";
import { bootstrapSession } from "./bootstrap-session.js";
import { DeliveryCoordinator } from "./runtime/delivery-coordinator.js";
import { runPromptWithOverflowRecovery } from "./runtime/overflow-recovery.js";
import { SubagentRegistry } from "./runtime/subagent-registry.js";
import {
  type AbortableAgentSummary,
  type ActiveAgentSummary,
  type SubagentState,
  isAbortableStatus,
  isAborted,
} from "./runtime/subagent-state.js";
import type { SubagentStatus } from "./subagent-messages.js";

export type {
  AbortableAgentSummary,
  ActiveAgentSummary,
} from "./runtime/subagent-state.js";

export interface AbortOwnedResult {
  abortedIds: string[];
  missingIds: string[];
  foreignIds: string[];
}

interface AbortOptions {
  reason: string;
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

export class CrewManager {
  private extensionResolvedPath: string;
  private registry = new SubagentRegistry();
  private delivery = new DeliveryCoordinator();
  private overflowAbortControllers = new Map<string, AbortController>();

  onWidgetUpdate: (() => void) | undefined;

  constructor(extensionResolvedPath: string) {
    this.extensionResolvedPath = extensionResolvedPath;
  }

  activateSession(
    sessionId: string,
    isIdle: () => boolean,
    pi: ExtensionAPI,
  ): void {
    this.delivery.activateSession(
      sessionId,
      isIdle,
      pi,
      (ownerSessionId, excludeId) =>
        this.registry.countRunningForOwner(ownerSessionId, excludeId),
    );
  }

  spawn(
    agentConfig: AgentConfig,
    task: string,
    cwd: string,
    ownerSessionId: string,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ): string {
    const state = this.registry.create(agentConfig, task, ownerSessionId);
    this.onWidgetUpdate?.();
    void this.spawnSession(
      state,
      cwd,
      ctx.sessionManager.getSessionFile(),
      ctx,
      pi,
    );
    return state.id;
  }

  private attachSessionListeners(
    state: SubagentState,
    session: AgentSession,
  ): void {
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

  /**
   * Single owner for post-prompt and terminal state transitions.
   * Publishes the outcome, updates state, and disposes finished subagents.
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

    this.delivery.deliver(
      state.ownerSessionId,
      {
        id: state.id,
        agentName: state.agentConfig.name,
        status: state.status,
        result: state.result,
        error: state.error,
      },
      pi,
      (ownerSessionId, excludeId) =>
        this.registry.countRunningForOwner(ownerSessionId, excludeId),
    );

    if (state.status !== "waiting") {
      this.disposeAgent(state);
    } else {
      this.onWidgetUpdate?.();
    }
  }

  private disposeAgent(state: SubagentState): void {
    state.session?.dispose();
    this.registry.delete(state.id);
    this.onWidgetUpdate?.();
  }

  private async runPromptCycle(
    state: SubagentState,
    prompt: string,
    pi: ExtensionAPI,
  ): Promise<void> {
    if (isAborted(state)) return;

    const abortController = new AbortController();
    this.overflowAbortControllers.set(state.id, abortController);

    try {
      const recovery = await runPromptWithOverflowRecovery(
        state.session!,
        prompt,
        abortController.signal,
      );
      if (isAborted(state)) return;

      const outcome = getPromptOutcome(state);

      // If overflow recovery ran but failed, keep the error from outcome.
      // If it recovered, outcome now reflects the retry turn's result.
      if (recovery === "failed" && outcome.status !== "error") {
        this.settleAgent(
          state,
          "error",
          {
            error: "Context overflow recovery failed",
          },
          pi,
        );
        return;
      }

      this.settleAgent(state, outcome.status, outcome, pi);
    } catch (err) {
      if (isAborted(state)) return;

      const error = err instanceof Error ? err.message : String(err);
      this.settleAgent(state, "error", { error }, pi);
    } finally {
      this.overflowAbortControllers.delete(state.id);
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
    this.onWidgetUpdate?.();
    void this.runPromptCycle(state, message, pi);
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

  abort(id: string, pi: ExtensionAPI, opts: AbortOptions): boolean {
    const state = this.registry.get(id);
    if (!state || !isAbortableStatus(state.status)) return false;

    this.overflowAbortControllers.get(id)?.abort();
    this.overflowAbortControllers.delete(id);
    state.session?.abortCompaction();
    state.session?.abortRetry();
    state.session?.abort().catch(() => {});
    this.settleAgent(state, "aborted", { error: opts.reason }, pi);
    return true;
  }

  abortOwned(
    ids: string[],
    callerSessionId: string,
    pi: ExtensionAPI,
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
      if (this.abort(id, pi, opts)) {
        result.abortedIds.push(id);
      } else {
        result.missingIds.push(id);
      }
    }

    return result;
  }

  abortAllOwned(
    callerSessionId: string,
    pi: ExtensionAPI,
    opts: AbortOptions,
  ): string[] {
    const ids = this.registry.getOwnedAbortableIds(callerSessionId);

    for (const id of ids) {
      this.abort(id, pi, opts);
    }

    return ids;
  }

  abortForOwner(ownerSessionId: string, pi: ExtensionAPI): void {
    this.abortAllOwned(ownerSessionId, pi, {
      reason: "Aborted on session shutdown",
    });
    this.delivery.clearPendingForOwner(ownerSessionId);
  }

  getAbortableAgents(): AbortableAgentSummary[] {
    return this.registry.getAbortableAgents();
  }

  getActiveSummariesForOwner(ownerSessionId: string): ActiveAgentSummary[] {
    return this.registry.getActiveSummariesForOwner(ownerSessionId);
  }
}
