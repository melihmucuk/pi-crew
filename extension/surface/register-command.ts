import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CrewManager } from "../runner.js";

export function registerCrewCommand(pi: ExtensionAPI, crewManager: CrewManager): void {
	pi.registerCommand("crew-abort", {
		description: "Abort an active subagent",

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
				const success = crewManager.abort(trimmed, pi, { reason: "Aborted by user command" });
				if (!success) {
					ctx.ui.notify(`No active subagent with id "${trimmed}"`, "error");
				} else {
					ctx.ui.notify(`Subagent ${trimmed} aborted`, "info");
				}
				return;
			}

			const activeAgents = crewManager.getAbortableAgents();
			if (activeAgents.length === 0) {
				ctx.ui.notify("No active subagents", "info");
				return;
			}

			const options = activeAgents.map((agent) => ({
				id: agent.id,
				label: `${agent.id} (${agent.agentName})`,
			}));
			const selected = await ctx.ui.select(
				"Select subagent to abort",
				options.map((option) => option.label),
			);
			if (!selected) return;

			const selectedOption = options.find((option) => option.label === selected);
			if (!selectedOption) return;

			const success = crewManager.abort(selectedOption.id, pi, { reason: "Aborted by user command" });
			if (success) {
				ctx.ui.notify(`Subagent ${selectedOption.id} aborted`, "info");
			} else {
				ctx.ui.notify(`Subagent ${selectedOption.id} already finished`, "error");
			}
		},
	});
}
