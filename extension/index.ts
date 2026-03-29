import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CrewManager } from "./runner.js";
import { registerCrewSurface } from "./surface.js";
import { updateWidget } from "./widget.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	const crewManager = new CrewManager(extensionDir);
	let currentCtx: ExtensionContext | undefined;

	const refreshWidget = () => {
		if (currentCtx) updateWidget(currentCtx, crewManager);
	};

	const activateSession = (ctx: ExtensionContext) => {
		currentCtx = ctx;
		crewManager.activateSession(
			ctx.sessionManager.getSessionId(),
			() => ctx.isIdle(),
			pi,
		);
		refreshWidget();
	};

	crewManager.onWidgetUpdate = refreshWidget;

	pi.on("session_start", (_event, ctx) => activateSession(ctx));
	pi.on("session_switch", (_event, ctx) => activateSession(ctx));
	pi.on("session_fork", (_event, ctx) => activateSession(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		crewManager.abortForOwner(ctx.sessionManager.getSessionId(), pi);
	});

	registerCrewSurface(pi, crewManager);
}
