import type { AgentConfig } from "../agent-discovery.js";
import type { AbortableAgentSummary, ActiveAgentSummary, SubagentState } from "./subagent-state.js";
import {
	buildAbortableAgentSummary,
	buildActiveAgentSummary,
	generateId,
	isAbortableStatus,
} from "./subagent-state.js";

export class SubagentRegistry {
	private activeAgents = new Map<string, SubagentState>();

	create(agentConfig: AgentConfig, task: string, ownerSessionId: string): SubagentState {
		const id = generateId(agentConfig.name, new Set(this.activeAgents.keys()));
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
		return state;
	}

	get(id: string): SubagentState | undefined {
		return this.activeAgents.get(id);
	}

	hasState(state: SubagentState): boolean {
		return this.activeAgents.get(state.id) === state;
	}

	delete(id: string): void {
		this.activeAgents.delete(id);
	}

	countRunningForOwner(ownerSessionId: string, excludeId: string): number {
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

	getAbortableAgents(): AbortableAgentSummary[] {
		return Array.from(this.activeAgents.values())
			.filter((state) => isAbortableStatus(state.status))
			.map(buildAbortableAgentSummary);
	}

	getActiveSummariesForOwner(ownerSessionId: string): ActiveAgentSummary[] {
		return Array.from(this.activeAgents.values())
			.filter(
				(state) => isAbortableStatus(state.status) && state.ownerSessionId === ownerSessionId,
			)
			.map(buildActiveAgentSummary);
	}

	getOwnedAbortableIds(ownerSessionId: string): string[] {
		return Array.from(this.activeAgents.values())
			.filter(
				(state) =>
					state.ownerSessionId === ownerSessionId && isAbortableStatus(state.status),
			)
			.map((state) => state.id);
	}

	getAllRunning(): SubagentState[] {
		return Array.from(this.activeAgents.values()).filter((state) =>
			isAbortableStatus(state.status),
		);
	}
}
