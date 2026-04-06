import {
	type SteeringPayload,
	sendRemainingNote,
	sendSteeringMessage,
	type SendMessageFn,
} from "../subagent-messages.js";

export interface ActiveRuntimeBinding {
	sessionId: string;
	isIdle: () => boolean;
	sendMessage: SendMessageFn;
}

interface PendingMessage {
	ownerSessionId: string;
	payload: SteeringPayload;
	queuedAt: number;
}

export class DeliveryCoordinator {
	private binding: ActiveRuntimeBinding | undefined;
	private pendingMessages: PendingMessage[] = [];
	private flushScheduled = false;

	activateSession(
		binding: ActiveRuntimeBinding,
		countRunningForOwner: (ownerSessionId: string, excludeId: string) => number,
	): void {
		this.binding = binding;
		// Delay flush to next macrotask. session_start fires before pi-core
		// calls _reconnectToAgent(), so synchronous delivery would emit agent
		// events while the session listener is disconnected, losing JSONL persistence.
		if (this.pendingMessages.some((entry) => entry.ownerSessionId === binding.sessionId)) {
			this.flushScheduled = true;
			setTimeout(() => {
				this.flushScheduled = false;
				this.flushPending(countRunningForOwner);
			}, 0);
		}
	}

	deactivateSession(sessionId: string): void {
		if (this.binding?.sessionId === sessionId) {
			this.binding = undefined;
		}
	}

	deliver(
		ownerSessionId: string,
		payload: SteeringPayload,
		countRunningForOwner: (ownerSessionId: string, excludeId: string) => number,
	): void {
		if (!this.binding || ownerSessionId !== this.binding.sessionId || this.flushScheduled) {
			this.pendingMessages.push({ ownerSessionId, payload, queuedAt: Date.now() });
			return;
		}

		this.send(ownerSessionId, payload, countRunningForOwner);
	}

	/**
	 * Remove pending messages older than the TTL.
	 * Called during activateSession to prevent unbounded memory growth.
	 */
	private cleanStaleMessages(): void {
		const maxAgeMs = 86_400_000; // 24 hours
		const cutoff = Date.now() - maxAgeMs;
		this.pendingMessages = this.pendingMessages.filter(
			(entry) => entry.queuedAt >= cutoff,
		);
	}

	private flushPending(
		countRunningForOwner: (ownerSessionId: string, excludeId: string) => number,
	): void {
		if (!this.binding) return;
		const targetSessionId = this.binding.sessionId;

		// Clean up stale messages first (older than TTL)
		this.cleanStaleMessages();

		const toDeliver: PendingMessage[] = [];
		const remaining: PendingMessage[] = [];

		for (const entry of this.pendingMessages) {
			if (entry.ownerSessionId === targetSessionId) {
				toDeliver.push(entry);
			} else {
				// Keep all other messages - they may be for sessions that will be reactivated later
				remaining.push(entry);
			}
		}

		// Keep messages for other sessions
		this.pendingMessages = remaining;

		// Deliver messages for the active session
		for (const entry of toDeliver) {
			this.send(entry.ownerSessionId, entry.payload, countRunningForOwner);
		}
	}

	/**
	 * Result messages always go first. If more subagents are still running and the
	 * owner is idle, queue the result without triggering, then queue the separate
	 * remaining note with triggerTurn so the next turn sees both in order.
	 */
	private send(
		ownerSessionId: string,
		payload: SteeringPayload,
		countRunningForOwner: (ownerSessionId: string, excludeId: string) => number,
	): void {
		if (!this.binding || this.binding.sessionId !== ownerSessionId) {
			this.pendingMessages.push({ ownerSessionId, payload, queuedAt: Date.now() });
			return;
		}

		const remaining = countRunningForOwner(ownerSessionId, payload.id);
		const isIdle = this.binding.isIdle();
		const triggerResultTurn = !(isIdle && remaining > 0);

		sendSteeringMessage(payload, this.binding.sendMessage, {
			isIdle,
			triggerTurn: triggerResultTurn,
		});
		sendRemainingNote(remaining, this.binding.sendMessage, {
			isIdle,
			triggerTurn: isIdle && remaining > 0,
		});
	}
}
