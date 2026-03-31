import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

const OVERFLOW_RECOVERY_TIMEOUT_MS = 120_000;

/**
 * Short grace period for the first terminal agent_end after prompt() resolves.
 * If this window expires, we still wait the full recovery timeout.
 */
const INITIAL_AGENT_END_WAIT_MS = 5_000;

type PhaseWaitResult = "done" | "timeout" | "cancelled";

export type OverflowRecoveryResult = "none" | "recovered" | "failed";

interface DeferredPhase {
	promise: Promise<void>;
	resolve: () => void;
	isDone: () => boolean;
}

function createDeferredPhase(): DeferredPhase {
	let done = false;
	let resolveFn: (() => void) | undefined;

	const promise = new Promise<void>((resolve) => {
		resolveFn = () => {
			if (done) return;
			done = true;
			resolve();
		};
	});

	return {
		promise,
		resolve: () => resolveFn?.(),
		isDone: () => done,
	};
}

class OverflowRecoveryTracker {
	private overflowDetected = false;
	private compactionWillRetry = false;

	private autoRetryActive = false;
	private readonly initialAgentEnd = createDeferredPhase();
	private compactionEnd: DeferredPhase | undefined;
	private retryAgentEnd: DeferredPhase | undefined;
	private overflowAutoRetryEnd: DeferredPhase | undefined;
	private timers: ReturnType<typeof setTimeout>[] = [];

	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_end":
				this.onAgentEnd();
				break;
			case "compaction_start":
				this.onCompactionStart(event.reason);
				break;
			case "compaction_end":
				this.onCompactionEnd(event.reason, event.willRetry);
				break;
			case "auto_retry_start":
				this.onAutoRetryStart();
				break;
			case "auto_retry_end":
				this.onAutoRetryEnd();
				break;
			default:
				break;
		}
	}

	async awaitCompletion(signal: AbortSignal): Promise<OverflowRecoveryResult> {
		const cancelPromise = new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener("abort", () => resolve(), { once: true });
		});

		try {
			let initialEnd = await this.waitForPhase(
				this.initialAgentEnd.promise,
				INITIAL_AGENT_END_WAIT_MS,
				cancelPromise,
			);

			if (initialEnd === "timeout") {
				initialEnd = await this.waitForPhase(
					this.initialAgentEnd.promise,
					OVERFLOW_RECOVERY_TIMEOUT_MS,
					cancelPromise,
				);
			}

			if (initialEnd !== "done") {
				return this.overflowDetected ? "failed" : "none";
			}

			if (!this.overflowDetected) return "none";

			if (this.compactionEnd) {
				const compactionEnd = await this.waitForPhase(
					this.compactionEnd.promise,
					OVERFLOW_RECOVERY_TIMEOUT_MS,
					cancelPromise,
				);
				if (compactionEnd !== "done") return "failed";
			}

			if (!this.compactionWillRetry) return "failed";

			if (this.retryAgentEnd) {
				const retryEnd = await this.waitForPhase(
					this.retryAgentEnd.promise,
					OVERFLOW_RECOVERY_TIMEOUT_MS,
					cancelPromise,
				);
				if (retryEnd !== "done") return "failed";
			}

			if (this.overflowAutoRetryEnd) {
				const autoRetryEnd = await this.waitForPhase(
					this.overflowAutoRetryEnd.promise,
					OVERFLOW_RECOVERY_TIMEOUT_MS,
					cancelPromise,
				);
				if (autoRetryEnd !== "done") return "failed";
			}

			return "recovered";
		} finally {
			for (const timer of this.timers) clearTimeout(timer);
		}
	}

	private async waitForPhase(
		phasePromise: Promise<void>,
		timeoutMs: number,
		cancelPromise: Promise<void>,
	): Promise<PhaseWaitResult> {
		return Promise.race([
			phasePromise.then(() => "done" as const),
			cancelPromise.then(() => "cancelled" as const),
			new Promise<"timeout">((resolve) => {
				this.timers.push(setTimeout(() => resolve("timeout"), timeoutMs));
			}),
		]);
	}

	// agent_end can be followed immediately by auto_retry_start in the same
	// _processAgentEvent tick. Resolve on microtask so we can ignore retrying
	// attempts and only accept terminal agent_end events.
	private onAgentEnd(): void {
		queueMicrotask(() => {
			if (this.autoRetryActive) return;

			if (!this.initialAgentEnd.isDone()) {
				this.initialAgentEnd.resolve();
				return;
			}

			this.retryAgentEnd?.resolve();
		});
	}

	private onCompactionStart(reason: "manual" | "threshold" | "overflow"): void {
		if (reason !== "overflow") return;
		this.overflowDetected = true;
		this.compactionEnd ??= createDeferredPhase();
	}

	private onCompactionEnd(reason: "manual" | "threshold" | "overflow", willRetry: boolean): void {
		if (reason !== "overflow") return;

		this.compactionWillRetry = willRetry;
		if (willRetry) {
			this.retryAgentEnd ??= createDeferredPhase();
		}
		this.compactionEnd?.resolve();
	}

	private onAutoRetryStart(): void {
		this.autoRetryActive = true;
		if (this.overflowDetected) {
			this.overflowAutoRetryEnd ??= createDeferredPhase();
		}
	}

	private onAutoRetryEnd(): void {
		this.autoRetryActive = false;
		this.overflowAutoRetryEnd?.resolve();
	}
}

export async function runPromptWithOverflowRecovery(
	session: AgentSession,
	text: string,
	signal: AbortSignal,
): Promise<OverflowRecoveryResult> {
	const tracker = new OverflowRecoveryTracker();
	const unsubscribe = session.subscribe((event) => tracker.handleEvent(event));

	try {
		await session.prompt(text);
		return await tracker.awaitCompletion(signal);
	} finally {
		unsubscribe();
	}
}
