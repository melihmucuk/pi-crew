import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CrewRuntime } from "./crew.js";

const SOURCE = "custom:pi-crew";
const METADATA_TTL_MS = 60_000;
let sequence = Date.now() * 1000;

/** Presentation only: Herdr's Pi integration remains the lifecycle authority. */
export function registerHerdrMetadata(
	pi: ExtensionAPI,
	crew: CrewRuntime,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const paneId = env.HERDR_PANE_ID;
	if (env.HERDR_ENV !== "1" || !paneId || !env.HERDR_SOCKET_PATH) return;
	const binary = env.HERDR_BIN_PATH || "herdr";
	let unsubscribe: (() => void) | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let runningCount = 0;
	let queue = Promise.resolve();
	let sending = false;
	let pendingCount: number | undefined;

	async function send(count: number): Promise<void> {
		const args = [
			"pane", "report-metadata", paneId!,
			"--source", SOURCE, "--agent", "pi",
			"--seq", String(sequence = Math.max(sequence + 1, Date.now() * 1000)),
		];
		if (count > 0) {
			args.push("--display-agent", `pi · ${count} ${count === 1 ? "subagent" : "subagents"}`,
				"--ttl-ms", String(METADATA_TTL_MS));
		} else {
			args.push("--clear-display-agent");
		}
		try {
			await pi.exec(binary, args, { timeout: 2_000 });
		} catch {
			// Missing/older Herdr binaries and IPC failures must not affect subagent work.
		}
	}

	function report(count: number): void {
		pendingCount = count;
		if (sending) return;
		sending = true;
		queue = queue.then(async () => {
			// Keep only the latest update while a report is in flight.
			while (pendingCount !== undefined) {
				const next = pendingCount;
				pendingCount = undefined;
				await send(next);
			}
			sending = false;
		});
	}

	function update(count: number): void {
		if (count === runningCount) return;
		runningCount = count;
		report(count);
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		if (count > 0) {
			// Renew only while working; abrupt exits leave at most one minute of stale metadata.
			refreshTimer = setInterval(() => report(runningCount), METADATA_TTL_MS / 2);
			refreshTimer.unref();
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || unsubscribe) return;
		unsubscribe = crew.observeRunningCount(update);
	});

	pi.on("session_shutdown", async () => {
		if (!unsubscribe) return;
		unsubscribe();
		unsubscribe = undefined;
		update(0);
		await queue;
	});
}
