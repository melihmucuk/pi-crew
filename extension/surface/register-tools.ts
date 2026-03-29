import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentDiscoveryWarning, discoverAgents } from "../agents.js";
import type { CrewManager } from "../runner.js";
import { STATUS_ICON } from "../steering.js";
import {
	renderCrewCall,
	renderCrewResult,
	toolError,
	toolSuccess,
	truncatePreview,
} from "./ui-helpers.js";

export function registerCrewTools(pi: ExtensionAPI, crewManager: CrewManager): void {
	const shownDiscoveryWarnings = new Set<string>();

	const notifyDiscoveryWarnings = (
		ctx: ExtensionContext,
		warnings: AgentDiscoveryWarning[],
	) => {
		if (!ctx.hasUI) return;
		for (const warning of warnings) {
			const key = `${warning.filePath}:${warning.message}`;
			if (shownDiscoveryWarnings.has(key)) continue;
			shownDiscoveryWarnings.add(key);
			ctx.ui.notify(`${warning.message} (${warning.filePath})`, "error");
		}
	};

	pi.registerTool({
		name: "crew_list",
		label: "List Crew",
		description:
			"List available agent definitions (from ~/.pi/agent/agents/*.md) and currently running agents with their status.",
		parameters: Type.Object({}),
		promptSnippet: "List agent definitions and active agents",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { agents, warnings } = discoverAgents();
			notifyDiscoveryWarnings(ctx, warnings);
			const callerSessionId = ctx.sessionManager.getSessionId();
			const running = crewManager.getActiveSummariesForOwner(callerSessionId);

			const lines: string[] = [];

			lines.push("## Available agents");
			if (agents.length === 0) {
				lines.push(
					"No valid agent definitions found. Add `.md` files to `~/.pi/agent/agents/`.",
				);
			} else {
				for (const agent of agents) {
					lines.push("");
					lines.push(`**${agent.name}**`);
					if (agent.description) lines.push(`  ${agent.description}`);
					if (agent.model) lines.push(`  model: ${agent.model}`);
					if (agent.interactive) lines.push("  interactive: true");
					if (agent.tools !== undefined) lines.push(`  tools: ${agent.tools.length > 0 ? agent.tools.join(", ") : "none"}`);
					if (agent.skills !== undefined) lines.push(`  skills: ${agent.skills.length > 0 ? agent.skills.join(", ") : "none"}`);
				}
			}

			if (warnings.length > 0) {
				lines.push("");
				lines.push("## Ignored agent definitions");
				for (const warning of warnings) {
					lines.push(`- ${warning.message} (${warning.filePath})`);
				}
			}

			lines.push("");
			lines.push("## Active agents");
			if (running.length === 0) {
				lines.push("No agents currently active.");
			} else {
				for (const agent of running) {
					const icon = STATUS_ICON[agent.status] ?? "❓";
					lines.push("");
					lines.push(`**${agent.id}** (${agent.agentName}) — ${icon} ${agent.status}`);
					lines.push(`  task: ${agent.taskPreview}`);
					lines.push(`  turns: ${agent.turns}`);
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

	pi.registerTool({
		name: "crew_spawn",
		label: "Spawn Crew",
		description:
			"Spawn a non-blocking agent that runs in an isolated session. The agent works independently while the current session stays interactive. Results are delivered back to the spawning session as steering messages when done. Use crew_list first to see available agents.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name from crew_list" }),
			task: Type.String({ description: "Task to delegate to the agent" }),
		}),
		promptSnippet:
			"Spawn a non-blocking agent. Use crew_list first to see available agents.",
		promptGuidelines: [
			"crew_spawn: Always call crew_list first to see which agents are available before spawning.",
			"crew_spawn: The spawned agent runs in a separate context window with no access to the current conversation. Include all relevant context (file paths, requirements, prior findings) directly in the task parameter.",
			"crew_spawn: Results are delivered asynchronously as steering messages. Do not block or poll for completion; continue working on other tasks.",
			"crew_spawn: Interactive agents (marked with 'interactive' in crew_list) stay alive after responding. Use crew_respond to continue the conversation and crew_done to close when finished.",
			"crew_spawn: When multiple agents are spawned, each result arrives as a separate steering message. NEVER predict or fabricate results for agents that have not yet reported back. Wait for ALL crew-result messages.",
		],

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agents, warnings } = discoverAgents();
			notifyDiscoveryWarnings(ctx, warnings);
			const agent = agents.find((candidate) => candidate.name === params.agent);

			if (!agent) {
				const available = agents.map((candidate) => candidate.name).join(", ") || "none";
				return toolError(`Unknown agent: "${params.agent}". Available: ${available}`);
			}

			const ownerSessionId = ctx.sessionManager.getSessionId();
			const id = crewManager.spawn(
				agent,
				params.task,
				ctx.cwd,
				ownerSessionId,
				ctx,
				pi,
			);

			return toolSuccess(`Agent '${agent.name}' spawned as ${id}. Result will be delivered as a steering message when done.`, { id });
		},

		renderCall(args, theme, _context) {
			const preview = args.task ? truncatePreview(args.task, 60) : "...";
			return renderCrewCall(theme, "crew_spawn", args.agent || "...", preview);
		},

		renderResult(result, _options, theme, _context) {
			return renderCrewResult(result, theme);
		},
	});

	pi.registerTool({
		name: "crew_respond",
		label: "Respond to Crew",
		description:
			"Send a follow-up message to an interactive agent that is waiting for a response. Use crew_list to see waiting agents.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "ID of the waiting agent (from crew_list or crew_spawn result)" }),
			message: Type.String({ description: "Message to send to the agent" }),
		}),
		promptSnippet: "Send a follow-up message to a waiting interactive agent.",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const callerSessionId = ctx.sessionManager.getSessionId();
			const { error } = crewManager.respond(params.agent_id, params.message, pi, callerSessionId);
			if (error) return toolError(error);

			return toolSuccess(
				`Message sent to agent ${params.agent_id}. Response will be delivered as a steering message.`,
				{ id: params.agent_id },
			);
		},

		renderCall(args, theme, _context) {
			const preview = args.message ? truncatePreview(args.message, 60) : "...";
			return renderCrewCall(theme, "crew_respond", args.agent_id || "...", preview);
		},

		renderResult(result, _options, theme, _context) {
			return renderCrewResult(result, theme);
		},
	});

	pi.registerTool({
		name: "crew_done",
		label: "Done with Crew",
		description:
			"Close an interactive agent session. Use when you no longer need to interact with the agent.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "ID of the agent to close" }),
		}),
		promptSnippet: "Close an interactive agent session when done.",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const callerSessionId = ctx.sessionManager.getSessionId();
			const { error } = crewManager.done(params.agent_id, callerSessionId);
			if (error) return toolError(error);

			return toolSuccess(`Agent ${params.agent_id} closed.`, { id: params.agent_id });
		},

		renderCall(args, theme, _context) {
			return renderCrewCall(theme, "crew_done", args.agent_id || "...");
		},

		renderResult(result, _options, theme, _context) {
			return renderCrewResult(result, theme);
		},
	});
}
