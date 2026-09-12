import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentResult } from "./subagent-result.js";
import type { SubagentSettlement } from "./subagent-status.js";

export type SendMessageFn = ExtensionAPI["sendMessage"];
export type AppendEntryFn = ExtensionAPI["appendEntry"];
type Message = Parameters<SendMessageFn>[0];

export interface CrewResultPayload {
	id: string;
	agentName: string;
	brief?: string;
	sessionFile?: string;
	settlement: SubagentSettlement;
}

interface CrewResultMessageIdentity {
	agentId: string;
	agentName: string;
	brief?: string;
	sessionFile?: string;
}

export type CrewResultMessageDetails = CrewResultMessageIdentity & SubagentSettlement;

/** Permissive stored shape used only to render messages written by older versions. */
export interface StoredCrewResultMessageDetails extends CrewResultMessageIdentity {
	status: string;
	result?: SubagentResult;
	error?: string;
	body?: string;
}

export interface CrewAbortEntryData {
	agentId: string;
	agentName: string;
	brief?: string;
	sessionFile?: string;
	error?: string;
}

// The owner session's streaming state never changes pi-crew's policy: a steer is queued
// into a running turn, and an idle owner gets a turn that delivers it immediately.
function sendWithDeliveryPolicy(message: Message, sendMessage: SendMessageFn): void {
	sendMessage(message, { deliverAs: "steer", triggerTurn: true });
}

function getModelContent(payload: CrewResultPayload): string {
	const identity = { subagent_id: payload.id, brief: payload.brief ?? "" };
	const settlement = payload.settlement;
	return JSON.stringify("result" in settlement
		? { ...identity, result: settlement.result }
		: { ...identity, status: settlement.status, error: settlement.error });
}

export function sendCrewResultMessage(
	payload: CrewResultPayload,
	sendMessage: SendMessageFn,
): void {
	sendWithDeliveryPolicy(
		{
			customType: "crew-result",
			content: getModelContent(payload),
			display: true,
			details: {
				agentId: payload.id,
				agentName: payload.agentName,
				brief: payload.brief,
				sessionFile: payload.sessionFile,
				...payload.settlement,
			} satisfies CrewResultMessageDetails,
		},
		sendMessage,
	);
}

/**
 * Aborts are TUI-only: the owner either requested the abort itself, so the `crew_abort`
 * tool result already carries the ids, or the session is shutting down.
 */
export function appendCrewAbortEntry(
	payload: CrewResultPayload,
	appendEntry: AppendEntryFn,
): void {
	appendEntry("crew-abort", {
		agentId: payload.id,
		agentName: payload.agentName,
		brief: payload.brief,
		sessionFile: payload.sessionFile,
		error: payload.settlement.error,
	} satisfies CrewAbortEntryData);
}
