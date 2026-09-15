import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CrewRuntime } from "./crew.js";
import { isSubagentStatusPhase } from "./subagent-status.js";

const SNAPSHOT_TYPE = "crew-status";
const REMINDER_TYPE = "crew-reminder";
const REMINDER_CALL_INTERVAL = 10;

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];

interface OwnerState {
	calls: number;
	visibleSnapshot?: string;
}

function contextMessageId(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || (message.customType !== SNAPSHOT_TYPE && message.customType !== REMINDER_TYPE)) return;
	const details = message.details;
	if (!details || typeof details !== "object" || !("crewContextId" in details)) return;
	return typeof details.crewContextId === "string" ? details.crewContextId : undefined;
}

function messageKey(message: AgentMessage): string {
	const id = contextMessageId(message);
	if (id) return id;
	if (message.role === "custom") return JSON.stringify([message.role, message.customType, message.content]);
	return JSON.stringify([message.role, message.timestamp, message.role === "toolResult" ? message.toolCallId : undefined]);
}

/** Restore only our missing persisted messages, in their original transcript order. */
function restoreMessages(messages: AgentMessage[], recorded: AgentMessage[]): AgentMessage[] {
	const present = new Set(messages.map(contextMessageId).filter((id) => id !== undefined));
	if (!recorded.some((message) => {
		const id = contextMessageId(message);
		return id !== undefined && !present.has(id);
	})) return messages;

	const positions = new Map<string, number[]>();
	messages.forEach((message, index) => {
		const key = messageKey(message);
		const indexes = positions.get(key) ?? [];
		indexes.push(index);
		positions.set(key, indexes);
	});
	const insertions = new Map<number, AgentMessage[]>();
	let before = messages.length;
	for (let index = recorded.length - 1; index >= 0; index--) {
		const message = recorded[index];
		const position = positions.get(messageKey(message))?.pop();
		if (position !== undefined) {
			before = position;
		} else if (contextMessageId(message)) {
			const missing = insertions.get(before) ?? [];
			missing.push(message);
			insertions.set(before, missing);
		}
	}
	if (insertions.size === 0) return messages;
	const restored: AgentMessage[] = [];
	for (let index = 0; index <= messages.length; index++) {
		const missing = insertions.get(index);
		if (missing) restored.push(...missing.reverse());
		if (index < messages.length) restored.push(messages[index]);
	}
	return restored;
}

/** Emit at safe append boundaries; repair SDK omissions without replacing existing messages. */
export function createCrewContextStatus(crew: CrewRuntime) {
	const owners = new Map<string, OwnerState>();
	function state(ctx: ExtensionContext): OwnerState {
		const id = ctx.sessionManager.getSessionId();
		let owner = owners.get(id);
		if (!owner) {
			owner = { calls: 0 };
			owners.set(id, owner);
		}
		return owner;
	}

	function recordedContext(ctx: ExtensionContext): AgentMessage[] {
		const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
		const latest = messages.slice().reverse().find((message) => message.role === "custom" && message.customType === SNAPSHOT_TYPE);
		state(ctx).visibleSnapshot = latest?.role === "custom" && typeof latest.content === "string" ? latest.content : undefined;
		return messages;
	}

	function statusMessage(customType: string, content: string): Message {
		return { customType, content, display: false, details: { crewContextId: randomUUID() } };
	}

	function nextMessage(ctx: ExtensionContext): Message | undefined {
		const owner = state(ctx);
		const agents = crew.getActiveSummariesForOwner(ctx.sessionManager.getSessionId())
			.map(({ id, status }) => ({ id, status }))
			.sort((a, b) => a.id.localeCompare(b.id));
		const content = JSON.stringify({ type: "crew_status", agents });
		if (content !== owner.visibleSnapshot && (agents.length > 0 || owner.visibleSnapshot !== undefined)) {
			owner.visibleSnapshot = content;
			owner.calls = 0;
			return statusMessage(SNAPSHOT_TYPE, content);
		}
		const waiting = agents.filter(({ status }) => isSubagentStatusPhase(status, "awaiting-owner"));
		if (waiting.length === 0) {
			owner.calls = 0;
			return;
		}
		if (owner.calls >= REMINDER_CALL_INTERVAL) {
			owner.calls = 0;
			return statusMessage(REMINDER_TYPE, JSON.stringify({ type: "crew_reminder", agents: waiting }));
		}
	}

	return {
		beforeStart(ctx: ExtensionContext): Message | undefined {
			recordedContext(ctx);
			return nextMessage(ctx);
		},
		observe(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
			state(ctx).calls++;
			return restoreMessages(messages, recordedContext(ctx));
		},
		end(ctx: ExtensionContext): Message | undefined {
			return nextMessage(ctx);
		},
	};
}
