import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "../../agent-discovery.js";
import { STATUS_ICON } from "../../subagent-messages.js";
import type { CrewToolDeps } from "./tool-deps.js";

export function registerCrewListTool({
	pi,
	crew,
	notifyDiscoveryWarnings,
}: CrewToolDeps): void {
	pi.registerTool({
		name: "crew_list",
		label: "List Crew",
		description:
			"List available subagent definitions and currently running subagents with their status.",
		parameters: Type.Object({}),
		promptSnippet: "List subagent definitions and active subagents",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { agents, warnings } = discoverAgents(ctx.cwd);
			notifyDiscoveryWarnings(ctx, warnings);
			const callerSessionId = ctx.sessionManager.getSessionId();
			const running = crew.getActiveSummariesForOwner(callerSessionId);

			const lines: string[] = [];

			lines.push("## Available Subagents");
			if (agents.length === 0) {
				lines.push(
					"No valid subagent definitions found. Add `.md` files to `<cwd>/.pi/agents/` or `~/.pi/agent/agents/`.",
				);
			} else {
				for (const agent of agents) {
					lines.push("");
					lines.push(`name: ${agent.name}`);
					lines.push(`description: ${agent.description}`);
					lines.push(`interactive: ${agent.interactive ? "true" : "false"}`);
				}
			}

			if (warnings.length > 0) {
				lines.push("");
				lines.push("## Ignored subagent definitions");
				for (const warning of warnings) {
					lines.push(`- ${warning.message} (${warning.filePath})`);
				}
			}

			lines.push("");
			lines.push("## Active Subagents");
			if (running.length === 0) {
				lines.push("No subagents currently active.");
			} else {
				for (const agent of running) {
					const icon = STATUS_ICON[agent.status] ?? "❓";
					lines.push("");
					lines.push(`id: ${agent.id}`);
					lines.push(`name: ${agent.agentName}`);
					lines.push(`status: ${icon} ${agent.status}`);
					lines.push(`task: ${agent.taskPreview}`);
					lines.push(`turns: ${agent.turns}`);
				}
			}

			const text = lines.join("\n");
			return { content: [{ type: "text", text }], details: {} };
		},

		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("crew_list")), 0, 0);
		},

		renderResult(result, _options, _theme, _context) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
