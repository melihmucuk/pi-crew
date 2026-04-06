import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentDiscoveryWarning } from "../../agent-discovery.js";
import type { CrewRuntime } from "../../runtime/crew-runtime.js";

export interface CrewToolDeps {
	pi: ExtensionAPI;
	crew: CrewRuntime;
	extensionDir: string;
	notifyDiscoveryWarnings: (
		ctx: ExtensionContext,
		warnings: AgentDiscoveryWarning[],
	) => void;
}
