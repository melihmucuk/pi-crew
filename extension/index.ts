import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./catalog.js";
import { crewRuntime, type CrewRuntime } from "./crew.js";
import { addCrewMentionAutocomplete, expandCrewMentionsInMessages } from "./mentions.js";
import { registerCrewTools } from "./tools.js";
import { CREW_WIDGET_TOGGLE_SHORTCUT, createCrewWidgetController, registerCrewMessageRenderers } from "./ui.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

interface ProcessHooks {
	on(event: "beforeExit", listener: () => void): unknown;
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

	processHooks.on("beforeExit", () => crew.abortAll());
}

export function registerPiCrewExtension(pi: ExtensionAPI, options: RegisterPiCrewExtensionOptions = {}) {
	const crew = options.crew ?? crewRuntime;
	let currentCtx: ExtensionContext | undefined;
	let widgetExpanded = false;
	let widgetShowToolCalls = true;
	const widgetController = createCrewWidgetController();

	setupProcessHooks(crew, options.processHooks ?? process, options.processHooksSetupKey ?? processHooksSetupKey);

	const refreshWidget = () => {
		if (currentCtx) widgetController.update(currentCtx, crew, widgetExpanded, widgetShowToolCalls);
	};

	const activateSession = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		widgetShowToolCalls = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() }).widget.showToolCalls;
		crew.activateSession(
			{
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				sendMessage: pi.sendMessage.bind(pi),
				appendEntry: pi.appendEntry.bind(pi),
			},
			refreshWidget,
		);
	};

	pi.on("session_start", (event, ctx) => {
		// A fork replaces the session id, so the work the old id owns must move before the activation flush.
		if (event.reason === "fork" && event.previousSessionFile) {
			crew.adoptSession(event.previousSessionFile, ctx.sessionManager.getSessionId());
		}
		activateSession(ctx);
		addCrewMentionAutocomplete(ctx);
	});

	pi.on("context", (event) => expandCrewMentionsInMessages(event.messages));

	pi.on("session_shutdown", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		crew.deactivateSession(sessionId);

		if (event.reason === "quit") {
			crew.abortAll();
		}
	});

	pi.registerShortcut(CREW_WIDGET_TOGGLE_SHORTCUT, {
		description: "Toggle subagent widget summary or details",
		handler: (ctx) => {
			widgetExpanded = !widgetExpanded;
			widgetController.update(ctx, crew, widgetExpanded, widgetShowToolCalls);
		},
	});

	registerCrewTools(pi, crew, options.extensionDir ?? extensionDir);
	registerCrewMessageRenderers(pi);
}

export default function (pi: ExtensionAPI) {
	registerPiCrewExtension(pi);
}
