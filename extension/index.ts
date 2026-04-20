import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type AbortOwnedResult,
	type AbortableAgentSummary,
	type ActiveAgentSummary,
	crewRuntime,
} from "./runtime/crew-runtime.js";
import { registerCrewIntegration } from "./integration.js";
import { updateWidget } from "./status-widget.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

// Process-level cleanup for subagents on exit
let processHooksSetup = false;

function setupProcessHooks() {
	if (processHooksSetup) return;
	processHooksSetup = true;

	const abortAndExit = (signal: string) => {
		crewRuntime.abortAll();
		// Re-raise to restore default Node termination behavior
		process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
	};

	process.once('SIGINT', () => abortAndExit('SIGINT'));
	process.once('SIGTERM', () => abortAndExit('SIGTERM'));
	process.on('beforeExit', () => crewRuntime.abortAll());
}

export default function (pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;

	setupProcessHooks();

	const refreshWidget = () => {
		if (currentCtx) updateWidget(currentCtx, crewRuntime);
	};

	const activateSession = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		crewRuntime.activateSession(
			{
				sessionId: ctx.sessionManager.getSessionId(),
				isIdle: () => ctx.isIdle(),
				sendMessage: pi.sendMessage.bind(pi),
			},
			refreshWidget,
		);
		refreshWidget();
	};

	pi.on("session_start", (_event, ctx) => {
		activateSession(ctx);
	});

	pi.on("session_before_switch", () => {
		// Session is about to switch - no action needed here.
		// Subagent cleanup is handled by process hooks, not session_shutdown.
	});

	pi.on("session_before_fork", () => {
		// Session is about to fork - no action needed here.
		// Subagent cleanup is handled by process hooks, not session_shutdown.
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		// Deactivate delivery to this session, but don't abort subagents.
		// Subagents continue running and will complete normally.
		// Real cleanup happens in process exit hooks.
		crewRuntime.deactivateSession(sessionId);
	});

	registerCrewIntegration(pi, crewRuntime, extensionDir);
}
