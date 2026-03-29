import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CrewManager } from "../runner.js";

export function registerCrewCommand(pi: ExtensionAPI, crewManager: CrewManager): void {
	pi.registerCommand("crew-abort", {
		description: "Abort an active agent",

		getArgumentCompletions(argumentPrefix) {
			const activeAgents = crewManager.getAbortableAgents();
			if (activeAgents.length === 0) return null;
			return activeAgents
				.filter((agent) => agent.id.startsWith(argumentPrefix))
				.map((agent) => ({
					value: agent.id,
					label: `${agent.id} (${agent.agentName})`,
				}));
		},

		async handler(args, ctx) {
			const trimmed = args.trim();

			if (trimmed) {
				const success = crewManager.abort(trimmed, pi);
				if (!success) {
					ctx.ui.notify(`No active agent with id "${trimmed}"`, "error");
				} else {
					ctx.ui.notify(`Agent ${trimmed} aborted`, "info");
				}
				return;
			}

			const activeAgents = crewManager.getAbortableAgents();
			if (activeAgents.length === 0) {
				ctx.ui.notify("No active agents", "info");
				return;
			}

			const options = activeAgents.map((agent) => ({
				id: agent.id,
				label: `${agent.id} (${agent.agentName})`,
			}));
			const selected = await ctx.ui.select(
				"Select agent to abort",
				options.map((option) => option.label),
			);
			if (!selected) return;

			const selectedOption = options.find((option) => option.label === selected);
			if (!selectedOption) return;

			const success = crewManager.abort(selectedOption.id, pi);
			if (success) {
				ctx.ui.notify(`Agent ${selectedOption.id} aborted`, "info");
			} else {
				ctx.ui.notify(`Agent ${selectedOption.id} already finished`, "error");
			}
		},
	});
}
