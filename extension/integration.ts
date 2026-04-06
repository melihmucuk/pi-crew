import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CrewRuntime } from "./runtime/crew-runtime.js";
import { registerCrewCommand } from "./integration/register-command.js";
import { registerCrewMessageRenderers } from "./integration/register-renderers.js";
import { registerCrewTools } from "./integration/register-tools.js";

export function registerCrewIntegration(
	pi: ExtensionAPI,
	crew: CrewRuntime,
	extensionDir: string,
): void {
	registerCrewTools(pi, crew, extensionDir);
	registerCrewCommand(pi, crew);
	registerCrewMessageRenderers(pi);
}
