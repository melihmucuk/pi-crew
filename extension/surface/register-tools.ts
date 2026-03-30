import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
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

function formatAbortToolMessage(result: {
  abortedIds: string[];
  missingIds: string[];
  foreignIds: string[];
}): string {
  const parts: string[] = [];

  if (result.abortedIds.length > 0) {
    parts.push(`Aborted ${result.abortedIds.length} subagent(s): ${result.abortedIds.join(", ")}`);
  }
  if (result.missingIds.length > 0) {
    parts.push(`Not found or already finished: ${result.missingIds.join(", ")}`);
  }
  if (result.foreignIds.length > 0) {
    parts.push(`Belong to a different session: ${result.foreignIds.join(", ")}`);
  }

  return parts.join("\n");
}

export function registerCrewTools(
  pi: ExtensionAPI,
  crewManager: CrewManager,
): void {
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
      "List available subagent definitions (from ~/.pi/agent/agents/*.md) and currently running subagents with their status.",
    parameters: Type.Object({}),
    promptSnippet: "List subagent definitions and active subagents",

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { agents, warnings } = discoverAgents();
      notifyDiscoveryWarnings(ctx, warnings);
      const callerSessionId = ctx.sessionManager.getSessionId();
      const running = crewManager.getActiveSummariesForOwner(callerSessionId);

      const lines: string[] = [];

      lines.push("## Available subagents");
      if (agents.length === 0) {
        lines.push(
          "No valid subagent definitions found. Add `.md` files to `~/.pi/agent/agents/`.",
        );
      } else {
        for (const agent of agents) {
          lines.push("");
          lines.push(`**${agent.name}**`);
          if (agent.description) lines.push(`  ${agent.description}`);
          if (agent.model) lines.push(`  model: ${agent.model}`);
          if (agent.interactive) lines.push("  interactive: true");
          if (agent.tools !== undefined)
            lines.push(
              `  tools: ${agent.tools.length > 0 ? agent.tools.join(", ") : "none"}`,
            );
          if (agent.skills !== undefined)
            lines.push(
              `  skills: ${agent.skills.length > 0 ? agent.skills.join(", ") : "none"}`,
            );
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
      lines.push("## Active subagents");
      if (running.length === 0) {
        lines.push("No subagents currently active.");
      } else {
        for (const agent of running) {
          const icon = STATUS_ICON[agent.status] ?? "❓";
          lines.push("");
          lines.push(
            `**${agent.id}** (${agent.agentName}) — ${icon} ${agent.status}`,
          );
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
      "Spawn a non-blocking subagent that runs in an isolated session. The subagent works independently while the current session stays interactive. Results are delivered back to the spawning session as steering messages when done. Use crew_list first to see available subagents.",
    parameters: Type.Object({
      subagent: Type.String({ description: "Subagent name from crew_list" }),
      task: Type.String({ description: "Task to delegate to the subagent" }),
    }),
    promptSnippet:
      "Spawn a non-blocking subagent. Use crew_list first to see available subagents.",
    promptGuidelines: [
      "Use crew_* tools to delegate parallelizable, independent tasks to specialized subagents. For interactive multi-turn workflows, use crew_respond/crew_done. Avoid spawning for trivial, single-turn tasks.",
      "crew_spawn: Always call crew_list first to see which subagents are available before spawning.",
      "crew_spawn: The spawned subagent runs in a separate context window with no access to the current conversation. Include all relevant context (file paths, requirements, prior findings) directly in the task parameter.",
      "crew_spawn: Results are delivered asynchronously as steering messages. Do not block or poll for completion; continue working on other tasks.",
      "crew_spawn: Interactive subagents (marked with 'interactive' in crew_list) stay alive after responding. Use crew_respond to continue the conversation and crew_done to close when finished.",
      "crew_spawn: When multiple subagents are spawned, each result arrives as a separate steering message. NEVER predict or fabricate results for subagents that have not yet reported back. Wait for ALL crew-result messages.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents, warnings } = discoverAgents();
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
      const id = crewManager.spawn(
        subagent,
        params.task,
        ctx.cwd,
        ownerSessionId,
        ctx,
        pi,
      );

      return toolSuccess(
        `Subagent '${subagent.name}' spawned as ${id}. Result will be delivered as a steering message when done.`,
        { id },
      );
    },

    renderCall(args, theme, _context) {
      const preview = args.task ? truncatePreview(args.task, 60) : "...";
      return renderCrewCall(
        theme,
        "crew_spawn",
        args.subagent || "...",
        preview,
      );
    },

    renderResult(result, _options, theme, _context) {
      return renderCrewResult(result, theme);
    },
  });

  pi.registerTool({
    name: "crew_abort",
    label: "Abort Crew",
    description:
      "Abort one, many, or all active subagents owned by the current session.",
    parameters: Type.Object({
      subagent_id: Type.Optional(
        Type.String({ description: "Single subagent ID to abort" }),
      ),
      subagent_ids: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          description: "Multiple subagent IDs to abort",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description: "Abort all active subagents owned by the current session",
        }),
      ),
    }),
    promptSnippet: "Abort one, many, or all active subagents from this session.",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const callerSessionId = ctx.sessionManager.getSessionId();
      const modeCount = Number(Boolean(params.subagent_id))
        + Number(Boolean(params.subagent_ids?.length))
        + Number(params.all === true);

      if (modeCount !== 1) {
        return toolError(
          'Provide exactly one of: subagent_id, subagent_ids, or all=true.',
        );
      }

      if (params.all) {
        const abortedIds = crewManager.abortAllOwned(callerSessionId, pi, {
          reason: "Aborted by tool request",
        });
        if (abortedIds.length === 0) {
          return toolError("No active subagents in the current session.");
        }

        return toolSuccess(
          `Aborted ${abortedIds.length} subagent(s): ${abortedIds.join(", ")}`,
          { ids: abortedIds },
        );
      }

      const ids = params.subagent_id
        ? [params.subagent_id]
        : (params.subagent_ids ?? []);
      const result = crewManager.abortOwned(ids, callerSessionId, pi, {
        reason: "Aborted by tool request",
      });
      const message = formatAbortToolMessage(result);

      if (result.abortedIds.length === 0) {
        return toolError(message || "No subagents were aborted.");
      }

      return toolSuccess(message, {
        ids: result.abortedIds,
        missing_ids: result.missingIds,
        foreign_ids: result.foreignIds,
      });
    },

    renderCall(args, theme, _context) {
      if (args.all) {
        return renderCrewCall(theme, "crew_abort", "all");
      }

      if (args.subagent_id) {
        return renderCrewCall(theme, "crew_abort", args.subagent_id);
      }

      const count = Array.isArray(args.subagent_ids) ? args.subagent_ids.length : 0;
      return renderCrewCall(theme, "crew_abort", `${count} ids`);
    },

    renderResult(result, _options, theme, _context) {
      return renderCrewResult(result, theme);
    },
  });

  pi.registerTool({
    name: "crew_respond",
    label: "Respond to Crew",
    description:
      "Send a follow-up message to an interactive subagent that is waiting for a response. Use crew_list to see waiting subagents.",
    parameters: Type.Object({
      subagent_id: Type.String({
        description:
          "ID of the waiting subagent (from crew_list or crew_spawn result)",
      }),
      message: Type.String({ description: "Message to send to the subagent" }),
    }),
    promptSnippet:
      "Send a follow-up message to a waiting interactive subagent.",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const callerSessionId = ctx.sessionManager.getSessionId();
      const { error } = crewManager.respond(
        params.subagent_id,
        params.message,
        pi,
        callerSessionId,
      );
      if (error) return toolError(error);

      return toolSuccess(
        `Message sent to subagent ${params.subagent_id}. Response will be delivered as a steering message.`,
        { id: params.subagent_id },
      );
    },

    renderCall(args, theme, _context) {
      const preview = args.message ? truncatePreview(args.message, 60) : "...";
      return renderCrewCall(
        theme,
        "crew_respond",
        args.subagent_id || "...",
        preview,
      );
    },

    renderResult(result, _options, theme, _context) {
      return renderCrewResult(result, theme);
    },
  });

  pi.registerTool({
    name: "crew_done",
    label: "Done with Crew",
    description:
      "Close an interactive subagent session. Use when you no longer need to interact with the subagent.",
    parameters: Type.Object({
      subagent_id: Type.String({ description: "ID of the subagent to close" }),
    }),
    promptSnippet: "Close an interactive subagent session when done.",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const callerSessionId = ctx.sessionManager.getSessionId();
      const { error } = crewManager.done(params.subagent_id, callerSessionId);
      if (error) return toolError(error);

      return toolSuccess(`Subagent ${params.subagent_id} closed.`, {
        id: params.subagent_id,
      });
    },

    renderCall(args, theme, _context) {
      return renderCrewCall(theme, "crew_done", args.subagent_id || "...");
    },

    renderResult(result, _options, theme, _context) {
      return renderCrewResult(result, theme);
    },
  });
}
