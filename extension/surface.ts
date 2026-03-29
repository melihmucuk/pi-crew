import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CrewManager } from "./runner.js";
import { registerCrewCommand } from "./surface/register-command.js";
import { registerCrewMessageRenderers } from "./surface/register-renderers.js";
import { registerCrewTools } from "./surface/register-tools.js";

export function registerCrewSurface(pi: ExtensionAPI, crewManager: CrewManager): void {
	registerCrewTools(pi, crewManager);
	registerCrewCommand(pi, crewManager);
	registerCrewMessageRenderers(pi);
}
