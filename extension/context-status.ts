import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** Emit at safe append boundaries and observe Pi's canonical model context. */
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

	function refreshVisibleSnapshot(ctx: ExtensionContext): void {
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const latest = messages.slice().reverse().find((message) => message.role === "custom" && message.customType === SNAPSHOT_TYPE);
		state(ctx).visibleSnapshot = latest?.role === "custom" && typeof latest.content === "string" ? latest.content : undefined;
	}

	function statusMessage(customType: string, content: string): Message {
		return { customType, content, display: false };
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
			refreshVisibleSnapshot(ctx);
			return nextMessage(ctx);
		},
		observe(ctx: ExtensionContext): void {
			state(ctx).calls++;
			refreshVisibleSnapshot(ctx);
		},
		end(ctx: ExtensionContext): Message | undefined {
			return nextMessage(ctx);
		},
	};
}
