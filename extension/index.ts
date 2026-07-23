import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { crewRuntime, type CrewRuntime } from "./crew.js";
import { registerCrewTools } from "./tools.js";
import { CREW_WIDGET_TOGGLE_SHORTCUT, registerCrewMessageRenderers, updateWidget } from "./ui.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

interface ProcessHooks {
	once(event: "SIGINT", listener: () => void): unknown;
	on(event: "beforeExit", listener: () => void): unknown;
	exit(code?: number): never;
}

interface RegisterPiCrewExtensionOptions {
	crew?: CrewRuntime;
	extensionDir?: string;
	processHooks?: ProcessHooks;
	processHooksSetupKey?: symbol;
}

// Process-level cleanup for subagents on exit
const processHooksSetupKey = Symbol.for("pi-crew.processHooksSetup");
const globalWithProcessHooks = globalThis as typeof globalThis & Record<
	symbol,
	boolean | undefined
>;

function setupProcessHooks(crew: CrewRuntime, processHooks: ProcessHooks, setupKey: symbol) {
	if (globalWithProcessHooks[setupKey]) return;
	globalWithProcessHooks[setupKey] = true;

	processHooks.once("SIGINT", () => {
		crew.abortAll();
		processHooks.exit(130);
	});
	processHooks.on("beforeExit", () => crew.abortAll());
}

export function registerPiCrewExtension(pi: ExtensionAPI, options: RegisterPiCrewExtensionOptions = {}) {
	const crew = options.crew ?? crewRuntime;
	let currentCtx: ExtensionContext | undefined;
	let widgetExpanded = false;

	setupProcessHooks(crew, options.processHooks ?? process, options.processHooksSetupKey ?? processHooksSetupKey);

	const refreshWidget = () => {
		if (currentCtx) updateWidget(currentCtx, crew, widgetExpanded);
	};

	const activateSession = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		crew.activateSession(
			{
				sessionId: ctx.sessionManager.getSessionId(),
				isIdle: () => ctx.isIdle(),
				sendMessage: pi.sendMessage.bind(pi),
			},
			refreshWidget,
		);
	};

	pi.on("session_start", (_event, ctx) => {
		activateSession(ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		crew.deactivateSession(sessionId);

		if (event.reason === "quit") {
			crew.abortAll();
		}
	});

	pi.registerShortcut(CREW_WIDGET_TOGGLE_SHORTCUT, {
		description: "Toggle latest three or ten subagent tool calls",
		handler: (ctx) => {
			widgetExpanded = !widgetExpanded;
			updateWidget(ctx, crew, widgetExpanded);
		},
	});

	registerCrewTools(pi, crew, options.extensionDir ?? extensionDir);
	registerCrewMessageRenderers(pi);
}

export default function (pi: ExtensionAPI) {
	registerPiCrewExtension(pi);
}
