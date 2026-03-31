import { randomBytes } from "node:crypto";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../agent-discovery.js";
import type { SubagentStatus } from "../subagent-messages.js";

export interface SubagentState {
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

export function generateId(name: string, existingIds: Set<string>): string {
  for (let i = 0; i < 10; i++) {
    const id = `${name}-${randomBytes(4).toString("hex")}`;
    if (!existingIds.has(id)) return id;
  }
  return `${name}-${randomBytes(8).toString("hex")}`;
}

// Status may change externally via abort(). Standalone function avoids TS narrowing.
export function isAborted(state: SubagentState): boolean {
  return state.status === "aborted";
}

export function isAbortableStatus(status: SubagentStatus): boolean {
  return status === "running" || status === "waiting";
}

export function buildActiveAgentSummary(
  state: SubagentState,
): ActiveAgentSummary {
  const taskPreview =
    state.task.length > 80 ? `${state.task.slice(0, 80)}...` : state.task;
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

export function buildAbortableAgentSummary(
  state: SubagentState,
): AbortableAgentSummary {
  return {
    id: state.id,
    agentName: state.agentConfig.name,
  };
}
