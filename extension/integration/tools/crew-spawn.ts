import { Type } from "@sinclair/typebox";
import { discoverAgents } from "../../agent-discovery.js";
import {
  renderCrewCall,
  renderCrewResult,
  toolError,
  toolSuccess,
} from "../tool-presentation.js";
import type { CrewToolDeps } from "./tool-deps.js";

export function registerCrewSpawnTool({
	pi,
	crew,
	extensionDir,
	notifyDiscoveryWarnings,
}: CrewToolDeps): void {
  pi.registerTool({
    name: "crew_spawn",
    label: "Spawn Crew",
    description:
      "Spawn a non-blocking subagent that runs in an isolated session. The subagent works independently while your session stays interactive. Results are delivered back to your session as steering messages.",
    parameters: Type.Object({
      subagent: Type.String({ description: "Subagent name from crew_list" }),
      task: Type.String({ description: "Task to delegate to the subagent" }),
    }),
    promptSnippet:
      "Spawn a non-blocking subagent. Use crew_list first to see available subagents.",
    promptGuidelines: [
      "Use crew_list first to see available subagents before spawning.",
      "crew_spawn: The subagent runs in isolation with no access to your session. Include file paths, requirements, and known locations directly in the task parameter.",
      "crew_spawn: DELEGATE means OWNERSHIP TRANSFER. Once you spawn a subagent for a task, that task is exclusively theirs. If you also work on it, you waste the subagent's effort and create conflicting results. After spawning, work on an UNRELATED task or end your turn.",
      "crew_spawn: To avoid duplication, gather only enough context to write a useful task (key files, entry points). Do not pre-investigate the full problem.",
      "crew_spawn: Results arrive asynchronously as steering messages. Do not predict or fabricate results. Wait for all crew-result messages before acting on them.",
      "crew_spawn: Never use crew_list as a completion polling loop. Wait for the steering message.",
      "crew_spawn: Interactive subagents stay alive after responding. Use crew_respond to continue and crew_done to close when finished.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents, warnings } = discoverAgents(ctx.cwd);
      notifyDiscoveryWarnings(ctx, warnings);
      const subagent = agents.find(
        (candidate) => candidate.name === params.subagent,
      );

      if (!subagent) {
        const available =
          agents.map((candidate) => candidate.name).join(", ") || "none";
        return toolError(
          `Unknown subagent: "${params.subagent}". Available: ${available}`,
        );
      }

      const ownerSessionId = ctx.sessionManager.getSessionId();
      const id = crew.spawn(
        subagent,
        params.task,
        ctx.cwd,
        ownerSessionId,
        {
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          parentSessionFile: ctx.sessionManager.getSessionFile(),
          onWarning: (msg) => ctx.ui.notify(msg, "warning"),
        },
        extensionDir,
      );

      return toolSuccess(
        `Subagent '${subagent.name}' spawned as ${id}. Result will be delivered as a steering message when done.`,
        { id, agentName: subagent.name, task: params.task },
      );
    },

    renderCall(args, theme, _context) {
      return renderCrewCall(
        theme,
        "crew_spawn",
        args.subagent || "...",
        args.task,
      );
    },

    renderResult(result, _options, theme, _context) {
      return renderCrewResult(result, theme);
    },
  });
}
