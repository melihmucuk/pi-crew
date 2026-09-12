import { SUBAGENT_OUTCOME, type SubagentResult } from "./subagent-result.js";

/**
 * Single source of truth for subagent lifecycle statuses.
 *
 * Call sites compare phases instead of raw status strings. `awaiting-owner` means a
 * successful cycle has been delivered and the agent stays visible, abortable, and open
 * to a `crew_respond` follow-up or an explicit `crew_done`. Successful statuses are the
 * `crew_report` outcomes themselves, so they derive from the result contract instead of
 * restating its tokens.
 */
export const SUBAGENT_STATUS = {
	running: "running",
	completed: SUBAGENT_OUTCOME.completed,
	needsInput: SUBAGENT_OUTCOME.needsInput,
	error: "error",
	aborted: "aborted",
} as const;

export type SubagentStatus = (typeof SUBAGENT_STATUS)[keyof typeof SUBAGENT_STATUS];
export type InFlightSubagentStatus = (typeof SUBAGENT_STATUS)["running"];

type SuccessfulSubagentSettlement = {
	[Outcome in SubagentResult["outcome"]]: {
		status: Outcome;
		result: Extract<SubagentResult, { outcome: Outcome }>;
		error?: never;
	};
}[SubagentResult["outcome"]];

/** Canonical result of a settled prompt cycle, runtime transition, and delivery. */
export type SubagentSettlement =
	| SuccessfulSubagentSettlement
	| { status: typeof SUBAGENT_STATUS.error; error: string; result?: never }
	| { status: typeof SUBAGENT_STATUS.aborted; error?: string; result?: never };

export type SubagentLifecycle =
	| { status: InFlightSubagentStatus; result?: never; error?: never }
	| SubagentSettlement;

export type SubagentStatusPhase = "in-flight" | "awaiting-owner" | "terminal";

const SUBAGENT_STATUS_PHASE = {
	[SUBAGENT_STATUS.running]: "in-flight",
	[SUBAGENT_STATUS.completed]: "awaiting-owner",
	[SUBAGENT_STATUS.needsInput]: "awaiting-owner",
	[SUBAGENT_STATUS.error]: "terminal",
	[SUBAGENT_STATUS.aborted]: "terminal",
} as const satisfies Record<SubagentStatus, SubagentStatusPhase>;

export function isSubagentStatusPhase(status: SubagentStatus, phase: SubagentStatusPhase): boolean {
	return SUBAGENT_STATUS_PHASE[status] === phase;
}

/** Tool-activity statuses describe one tool call, not the agent, and never become lifecycle statuses. */
export const SUBAGENT_TOOL_STATUS = {
	running: "running",
	done: "done",
	error: "error",
} as const;

export type SubagentToolStatus = (typeof SUBAGENT_TOOL_STATUS)[keyof typeof SUBAGENT_TOOL_STATUS];

export interface SubagentToolActivity {
	id: string;
	name: string;
	target: string;
	status: SubagentToolStatus;
	resultSummary?: string;
}
