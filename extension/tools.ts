import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  discoverAgents,
  type AgentConfig,
  type AgentDiscoveryWarning,
} from "./catalog.js";
import type {
  ActiveAgentSummary,
  CrewRuntime,
} from "./crew.js";
import { formatDuration, formatModelLabel, parseModelId } from "./format.js";
import {
  CrewTaskSchema,
  type CrewTask,
  formatCrewTask,
  validateCrewTask,
} from "./task.js";
import { sanitizeInline } from "./tool-activity.js";
import { formatAbortResult, jsonToolError, type CrewActionResult } from "./tool-output.js";
import {
  getSubagentStatusPresentation,
  renderCrewCall,
  renderCrewResult,
} from "./ui.js";

export type CrewToolResult = AgentToolResult<unknown>;

const PROJECT_CONFIG_DIR_NAME = piCodingAgent.CONFIG_DIR_NAME ?? ".pi";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolRenderCall = Exclude<RegisteredTool["renderCall"], undefined>;

interface ToolContext {
  cwd: string;
  callerSessionId: string;
  projectTrusted: boolean;
}

function getToolContext(ctx: ExtensionContext): ToolContext {
  return {
    cwd: ctx.cwd,
    callerSessionId: ctx.sessionManager.getSessionId(),
    projectTrusted: ctx.isProjectTrusted(),
  };
}

function toolSuccess(
  payload: Record<string, unknown>,
  details: Record<string, unknown> = payload,
  options: { terminate?: boolean } = {},
): CrewToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details,
    ...(options.terminate ? { terminate: true } : {}),
  };
}

type CrewListAgentDetails = {
  name: string;
  description: string;
  model: string | undefined;
  modelName: string | undefined;
  thinking: string | undefined;
};

type CrewListDetails = {
  agents: CrewListAgentDetails[];
  warnings: AgentDiscoveryWarning[];
};

type CrewStatusSubagentDetails = {
  id: string;
  name: string;
  brief: string | undefined;
  status: string;
  model: string | undefined;
  modelName: string | undefined;
  workedMs: number;
};

type CrewStatusDetails = {
  subagents: CrewStatusSubagentDetails[];
};

function buildCrewListDetails(
  agents: AgentConfig[],
  warnings: AgentDiscoveryWarning[],
  ctx: ExtensionContext,
): CrewListDetails {
  return {
    agents: agents.map((agent) => {
      const parsed = parseModelId(agent.model);
      const resolvedName = parsed
        ? ctx.modelRegistry.find(parsed.provider, parsed.modelId)?.name
        : undefined;
      return {
        name: agent.name,
        description: agent.description,
        model: agent.model,
        modelName: resolvedName,
        thinking: agent.thinking,
      };
    }),
    warnings,
  };
}

function buildCrewStatusDetails(active: ActiveAgentSummary[]): CrewStatusDetails {
  return {
    subagents: active.map((agent) => ({
      id: agent.id,
      name: agent.agentName,
      brief: agent.brief,
      status: agent.status,
      model: agent.model,
      modelName: agent.modelName,
      workedMs: agent.workedMs,
    })),
  };
}

function crewListModelContent(details: CrewListDetails): Record<string, unknown> {
  return {
    agents: details.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      model: agent.model ?? null,
      thinking: agent.thinking ?? null,
    })),
    warnings: details.warnings.map((warning) => ({
      message: warning.message,
      file_path: warning.filePath,
    })),
  };
}

function crewStatusModelContent(details: CrewStatusDetails): Record<string, unknown> {
  return {
    agents: details.subagents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      brief: agent.brief ?? "",
      status: agent.status,
    })),
  };
}

function renderCrewList(details: CrewListDetails, theme: Parameters<ToolRenderCall>[1]): Component {
  return {
    render(width) {
      const box = new Box(0, 0);
      box.addChild(new Text(theme.fg("toolTitle", theme.bold(`Available subagents · ${details.agents.length}`)), 0, 0));
      if (details.agents.length === 0) {
        box.addChild(new Spacer());
        box.addChild(new Text(`No valid subagent definitions found. Add .md files to <cwd>/${PROJECT_CONFIG_DIR_NAME}/agents/ or ${piCodingAgent.getAgentDir()}/agents/.`, 0, 0));
      }
      for (const agent of details.agents) {
        const model = formatModelLabel(agent.model, agent.modelName) ?? "owner session model";
        box.addChild(new Spacer());
        box.addChild(new Text(
          theme.fg("accent", theme.bold(sanitizeInline(agent.name)))
            + theme.fg("muted", ` · ${sanitizeInline(model)} · ${agent.thinking ?? "model default"}`),
          0, 0,
        ));
        box.addChild(new Text(sanitizeInline(agent.description), 2, 0));
      }
      if (details.warnings.length > 0) {
        box.addChild(new Spacer());
        box.addChild(new Text(theme.fg("warning", theme.bold("Discovery warnings")), 0, 0));
        for (const warning of details.warnings) {
          box.addChild(new Text(`${sanitizeInline(warning.message)} (${sanitizeInline(warning.filePath)})`, 2, 0));
        }
      }
      return box.render(width);
    },
    // Styles are rebuilt on render so theme changes cannot leave stale colors.
    invalidate() {},
  };
}

function crewStatusText(details: CrewStatusDetails): string {
  if (details.subagents.length === 0) return "No open subagent sessions.";
  const lines = ["Subagent sessions"];
  for (const agent of details.subagents) {
    const presentation = getSubagentStatusPresentation(agent.status);
    const model = formatModelLabel(agent.model, agent.modelName) ?? "resolving";
    lines.push(
      "",
      `- ${sanitizeInline(agent.id)} · ${sanitizeInline(agent.name)} — ${sanitizeInline(agent.brief ?? "no brief")}`,
      `  ${presentation.icon} ${presentation.label} · model: ${sanitizeInline(model)} · worked: ${formatDuration(agent.workedMs)}`,
    );
  }
  return lines.join("\n");
}

function notifyDiscoveryWarnings(
  ctx: ExtensionContext,
  shownDiscoveryWarnings: Set<string>,
  warnings: AgentDiscoveryWarning[],
): void {
  if (!ctx.hasUI) return;
  for (const warning of warnings) {
    const key = `${warning.filePath}:${warning.message}`;
    if (shownDiscoveryWarnings.has(key)) continue;
    shownDiscoveryWarnings.add(key);
    ctx.ui.notify(`${warning.message} (${warning.filePath})`, "error");
  }
}

function registerActionTool<Params extends object>(
  pi: ExtensionAPI,
  options: Omit<RegisteredTool, "execute" | "renderResult" | "renderCall"> & {
    action: (params: Params, ctx: ExtensionContext) => CrewToolResult;
    renderCall?: (
      args: Partial<Params>,
      theme: Parameters<ToolRenderCall>[1],
      context: Parameters<ToolRenderCall>[2],
    ) => ReturnType<ToolRenderCall>;
  },
): void {
  const { action, renderCall, ...tool } = options;
  pi.registerTool({
    ...tool,
    ...(renderCall
      ? {
          renderCall: (args, theme, context) =>
            renderCall(args as Partial<Params>, theme, context),
        }
      : {}),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        return action(params as Params, ctx);
      } catch (error) {
        throw jsonToolError(error);
      }
    },
    renderResult(result, _options, theme, context) {
      return renderCrewResult(result, theme, context.isError);
    },
  });
}

export function registerCrewTools(
  pi: ExtensionAPI,
  crew: CrewRuntime,
  extensionDir: string,
): void {
  const shownDiscoveryWarnings = new Set<string>();

  pi.registerTool({
    name: "crew_list",
    label: "List Crew",
    description: "List available subagent definitions and discovery warnings.",
    parameters: Type.Object({}),
    promptSnippet: "List available subagent definitions for discovery.",
    promptGuidelines: [
      "crew_list: Use for discovery of subagent definitions; use crew_status for a snapshot of your open subagents.",
    ],
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const toolCtx = getToolContext(ctx);
        const { agents, warnings } = discoverAgents(toolCtx.cwd, {
          projectTrusted: toolCtx.projectTrusted,
        });
        notifyDiscoveryWarnings(ctx, shownDiscoveryWarnings, warnings);
        const details = buildCrewListDetails(agents, warnings, ctx);
        return toolSuccess(crewListModelContent(details), details);
      } catch (error) {
        throw jsonToolError(error);
      }
    },
    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("crew_list")), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) return renderCrewResult(result, theme, true);
      // Persisted results from before structured discovery details contain only text.
      if (result.details && Object.keys(result.details).length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      const details = result.details as CrewListDetails;
      return renderCrewList(details, theme);
    },
  });

  pi.registerTool({
    name: "crew_status",
    label: "Crew Status",
    description: "Snapshot the open subagents owned by the current session.",
    parameters: Type.Object({}),
    promptSnippet: "Snapshot this session's open subagents.",
    promptGuidelines: [
      "crew_status: Use for a one-time snapshot of your open subagents; results arrive automatically, so never poll it for completion.",
    ],
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const { callerSessionId } = getToolContext(ctx);
        const details = buildCrewStatusDetails(
          crew.getActiveSummariesForOwner(callerSessionId),
        );
        return toolSuccess(crewStatusModelContent(details), details);
      } catch (error) {
        throw jsonToolError(error);
      }
    },
    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("crew_status")), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) return renderCrewResult(result, theme, true);
      const details = result.details as CrewStatusDetails;
      return new Text(crewStatusText(details), 0, 0);
    },
  });

  registerActionTool<{ subagent: string; brief: string; task: CrewTask }>(pi, {
    name: "crew_spawn",
    label: "Spawn Crew",
    description: "Spawn a non-blocking subagent in an isolated session.",
    parameters: Type.Object({
      subagent: Type.String({ description: "Subagent name from crew_list" }),
      brief: Type.String({
        description:
          "Label under 80 characters for lists. Not the task.",
      }),
      task: CrewTaskSchema,
    }, { additionalProperties: false }),
    promptSnippet: "Spawn a subagent for delegated work.",
    promptGuidelines: [
      "crew_spawn: An inline <pi-crew .../> reference identifies the user's selected subagent; it does not require spawning. Delegate only when the sentence's intent asks for delegation.",
      "crew_spawn: Spawn independent parts in parallel in one turn. Never duplicate delegated work; continue only with independent scope, otherwise end the turn and let results arrive.",
    ],
    action: (params, ctx) => {
      const brief = params.brief.trim();
      if (!brief) throw new Error("brief is required and must not be empty.");
      validateCrewTask(params.task);

      const toolCtx = getToolContext(ctx);
      const { agents, warnings } = discoverAgents(toolCtx.cwd, {
        projectTrusted: toolCtx.projectTrusted,
      });
      notifyDiscoveryWarnings(ctx, shownDiscoveryWarnings, warnings);
      const subagent = agents.find(
        (candidate) => candidate.name === params.subagent,
      );
      if (!subagent) {
        const available =
          agents.map((candidate) => candidate.name).join(", ") || "none";
        throw new Error(
          `Unknown subagent: "${params.subagent}". Available: ${available}`,
        );
      }

      const id = crew.spawn(
        subagent,
        params.task,
        toolCtx.cwd,
        toolCtx.callerSessionId,
        {
          brief,
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          agentDir: piCodingAgent.getAgentDir(),
          parentSessionFile: ctx.sessionManager.getSessionFile(),
          onWarning: (msg) => ctx.ui.notify(msg, "warning"),
        },
        extensionDir,
      );
      return toolSuccess({ subagent_id: id }, { action: "spawn", subagent_id: id, name: subagent.name } satisfies CrewActionResult);
    },
    renderCall(args, theme, context) {
      const subagent = args.subagent || "...";
      const title = args.brief ? `${subagent} · ${args.brief}` : subagent;
      let expandedTask: string | undefined;
      if (context.expanded && context.argsComplete) {
        try {
          validateCrewTask(args.task);
          expandedTask = formatCrewTask(args.task);
        } catch {
          // Keep rendering partial or invalid tool arguments with the compact preview.
        }
      }
      return renderCrewCall(
        theme,
        "crew_spawn",
        title,
        args.task?.goal,
        expandedTask,
      );
    },
  });

  registerActionTool<{
    subagent_id?: string;
    subagent_ids?: string[];
    all?: boolean;
  }>(pi, {
    name: "crew_abort",
    label: "Abort Crew",
    description: "Abort active subagents owned by this session.",
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
          description:
            "Abort all active subagents owned by the current session",
        }),
      ),
    }),
    promptSnippet: "Abort active subagents.",
    promptGuidelines: [
      "crew_abort: Only for work that became obsolete, wrong, or cancelled; an incomplete result is not a reason.",
    ],
    action: (params, ctx) => {
      const { callerSessionId } = getToolContext(ctx);
      const modeCount =
        Number(Boolean(params.subagent_id)) +
        Number(Boolean(params.subagent_ids?.length)) +
        Number(params.all === true);
      if (modeCount !== 1) {
        throw new Error(
          "Provide exactly one of: subagent_id, subagent_ids, or all=true.",
        );
      }

      if (params.all) {
        const abortedIds = crew.abortAllOwned(callerSessionId, {
          reason: "Aborted by tool request",
        });
        if (abortedIds.length === 0) {
          throw new Error("No active subagents in the current session.");
        }
        const payload = { aborted_ids: abortedIds, missing_ids: [], foreign_ids: [] };
        return toolSuccess(payload, { action: "abort", ...payload } satisfies CrewActionResult, { terminate: true });
      }

      const ids = params.subagent_id
        ? [params.subagent_id]
        : (params.subagent_ids ?? []);
      const result = crew.abortOwned(ids, callerSessionId, {
        reason: "Aborted by tool request",
      });
      const payload = {
        aborted_ids: result.abortedIds,
        missing_ids: result.missingIds,
        foreign_ids: result.foreignIds,
      };
      if (result.abortedIds.length === 0) {
        throw new Error(formatAbortResult(payload) || "No subagents were aborted.");
      }
      return toolSuccess(payload, { action: "abort", ...payload } satisfies CrewActionResult, { terminate: true });
    },
    renderCall(args, theme, _context) {
      if (args.all) return renderCrewCall(theme, "crew_abort", "all");
      if (args.subagent_id)
        return renderCrewCall(theme, "crew_abort", args.subagent_id);
      const count = Array.isArray(args.subagent_ids)
        ? args.subagent_ids.length
        : 0;
      return renderCrewCall(theme, "crew_abort", `${count} ids`);
    },
  });

  registerActionTool<{ subagent_id: string; message: string }>(pi, {
    name: "crew_respond",
    label: "Respond to Crew",
    description: "Send a follow-up to a subagent awaiting an owner action. Only use when the subagent is completed or needs_input. Do not send messages while it is running. It remembers its own session, not yours.",
    parameters: Type.Object({
      subagent_id: Type.String({
        description:
          "ID of the subagent awaiting an owner action (from crew_status or crew_spawn result)",
      }),
      message: Type.String({
        description:
          "Only what the subagent could not see since its last turn: user decisions, files changed by others, corrections. Do not restate its task. Short items, ending with when to stop.",
      }),
    }),
    promptSnippet: "Respond to a subagent awaiting an owner action.",
    promptGuidelines: [
      "crew_respond: Answer a needs_input request or correct the same completed deliverable. New scope or a different deliverable requires a new crew_spawn.",
    ],
    action: (params, ctx) => {
      const { callerSessionId } = getToolContext(ctx);
      const { error } = crew.respond(
        params.subagent_id,
        params.message,
        callerSessionId,
      );
      if (error) throw new Error(error);
      return toolSuccess({ subagent_id: params.subagent_id }, { action: "respond", subagent_id: params.subagent_id } satisfies CrewActionResult);
    },
    renderCall(args, theme, _context) {
      return renderCrewCall(
        theme,
        "crew_respond",
        args.subagent_id || "...",
        args.message,
      );
    },
  });

  registerActionTool<{ subagent_id: string }>(pi, {
    name: "crew_done",
    label: "Done with Crew",
    description: "Close a subagent awaiting an owner action after its delivered result is verified.",
    parameters: Type.Object({
      subagent_id: Type.String({ description: "ID of the subagent to close" }),
    }),
    promptSnippet: "Close a subagent awaiting an owner action after verifying its delivered result.",
    promptGuidelines: [
      "crew_done: Verify the delivered result before closing; use crew_respond instead when the same delivery needs correction.",
    ],
    action: (params, ctx) => {
      const { callerSessionId } = getToolContext(ctx);
      const { error } = crew.done(params.subagent_id, callerSessionId);
      if (error) throw new Error(error);
      return toolSuccess({ subagent_id: params.subagent_id }, { action: "done", subagent_id: params.subagent_id } satisfies CrewActionResult);
    },
    renderCall(args, theme, _context) {
      return renderCrewCall(theme, "crew_done", args.subagent_id || "...");
    },
  });
}
