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

	process.once('SIGINT', () => {
		crewRuntime.abortAll();
		process.exit(130);
	});
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

	pi.on("session_shutdown", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		crewRuntime.deactivateSession(sessionId);

		if (event.reason === "quit") {
			crewRuntime.abortAll();
		}
	});

	registerCrewIntegration(pi, crewRuntime, extensionDir);
}
