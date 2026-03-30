import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type SubagentStatus = "running" | "waiting" | "done" | "error" | "aborted";

export const STATUS_ICON: Record<SubagentStatus, string> = {
	running: "⏳",
	waiting: "⏳",
	done: "✅",
	error: "❌",
	aborted: "⏹️",
};

export const STATUS_LABEL: Record<SubagentStatus, string> = {
	running: "running",
	waiting: "waiting for response",
	done: "done",
	error: "failed",
	aborted: "aborted",
};

export interface SteeringPayload {
	id: string;
	agentName: string;
	status: SubagentStatus;
	result?: string;
	error?: string;
}

export interface CrewResultMessageDetails {
	agentId: string;
	agentName: string;
	status: SubagentStatus;
	body?: string;
}

export function getCrewResultTitle(details: {
	agentId: string;
	agentName: string;
	status: SubagentStatus;
}): string {
	return `Agent '${details.agentName}' (${details.agentId}) ${STATUS_LABEL[details.status]}`;
}

function getSteeringBody(payload: SteeringPayload): string | undefined {
	return (payload.status === "error" || payload.status === "aborted")
		? (payload.error ?? payload.result)
		: (payload.result ?? payload.error);
}

export function sendSteeringMessage(
	payload: SteeringPayload,
	pi: ExtensionAPI,
	opts: { isIdle: boolean; triggerTurn: boolean },
): void {
	const body = getSteeringBody(payload);
	const title = getCrewResultTitle({
		agentId: payload.id,
		agentName: payload.agentName,
		status: payload.status,
	});
	const content = body
		? `**${STATUS_ICON[payload.status]} ${title}**\n\n${body}`
		: `**${STATUS_ICON[payload.status]} ${title}**`;

	const message = {
		customType: "crew-result",
		content,
		display: true,
		details: {
			agentId: payload.id,
			agentName: payload.agentName,
			status: payload.status,
			body,
		} satisfies CrewResultMessageDetails,
	};

	pi.sendMessage(
		message,
		opts.isIdle
			? { triggerTurn: opts.triggerTurn }
			: { deliverAs: "steer", triggerTurn: opts.triggerTurn },
	);
}

export function sendRemainingNote(
	remainingCount: number,
	pi: ExtensionAPI,
	opts: { isIdle: boolean; triggerTurn: boolean },
): void {
	if (remainingCount <= 0) return;

	pi.sendMessage(
		{
			customType: "crew-remaining",
			content: `⏳ ${remainingCount} agent(s) still running`,
			display: true,
		},
		opts.isIdle
			? { triggerTurn: opts.triggerTurn }
			: { deliverAs: "steer", triggerTurn: opts.triggerTurn },
	);
}
