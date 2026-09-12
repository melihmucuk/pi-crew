import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  discoverAgents,
  type AgentConfig,
  type AgentDiscoveryWarning,
} from "./catalog.js";
import type {
  AbortOwnedResult,
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
  text: string,
  details: Record<string, unknown> = {},
  options: { terminate?: boolean } = {},
): CrewToolResult {
  return {
    content: [{ type: "text", text }],
    details,
    ...(options.terminate ? { terminate: true } : {}),
  };
}

function formatAvailableAgents(agents: AgentConfig[], ctx: ExtensionContext): string[] {
  if (agents.length === 0) {
    return [
      `No valid subagent definitions found. Add \`.md\` files to \`<cwd>/${PROJECT_CONFIG_DIR_NAME}/agents/\` or \`${piCodingAgent.getAgentDir()}/agents/\`.`,
    ];
  }

  return agents.flatMap((agent) => {
    const parsed = parseModelId(agent.model);
    const resolvedName = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId)?.name : undefined;
    return [
      "",
      `name: ${agent.name}`,
      `description: ${agent.description}`,
      `model: ${formatModelLabel(agent.model, resolvedName) ?? "owner session model"}`,
      `thinking: ${agent.thinking ?? "model default"}`,
    ];
  });
}

function formatWarnings(warnings: AgentDiscoveryWarning[]): string[] {
  if (warnings.length === 0) return [];
  return [
    "",
    "## Ignored subagent definitions",
    ...warnings.map((warning) => `- ${warning.message} (${warning.filePath})`),
  ];
}

function formatActiveAgents(active: ActiveAgentSummary[]): string[] {
  if (active.length === 0) return ["No subagents currently active."];
  return active.flatMap((agent) => {
    return [
      "",
      `id: ${agent.id}`,
      `name: ${agent.agentName}`,
      ...(agent.brief ? [`brief: ${sanitizeInline(agent.brief)}`] : []),
      `status: ${getSubagentStatusPresentation(agent.status).label}`,
      `model: ${formatModelLabel(agent.model, agent.modelName) ?? "resolving"}`,
      `worked: ${formatDuration(agent.workedMs)}`,
    ];
  });
}

function formatAbortToolMessage(result: AbortOwnedResult): string {
  const parts: string[] = [];
  if (result.abortedIds.length > 0)
    parts.push(
      `Aborted ${result.abortedIds.length} subagent(s): ${result.abortedIds.join(", ")}`,
    );
  if (result.missingIds.length > 0)
    parts.push(
      `Not found or already finished: ${result.missingIds.join(", ")}`,
    );
  if (result.foreignIds.length > 0)
    parts.push(
      `Belong to a different session: ${result.foreignIds.join(", ")}`,
    );
  return parts.join("\n");
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
      return action(params as Params, ctx);
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
    description: "List subagent definitions and active subagents.",
    parameters: Type.Object({}),
    promptSnippet: "List available subagents and active subagents.",
    promptGuidelines: [
      "crew_list: Use for discovery or a status snapshot; never poll for completion.",
    ],
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const toolCtx = getToolContext(ctx);
      const { agents, warnings } = discoverAgents(toolCtx.cwd, {
        projectTrusted: toolCtx.projectTrusted,
      });
      const active = crew.getActiveSummariesForOwner(toolCtx.callerSessionId);
      const lines = [
        "## Available Subagents",
        ...formatAvailableAgents(agents, ctx),
        ...formatWarnings(warnings),
        "",
        "## Active Subagents",
        ...formatActiveAgents(active),
      ];
      notifyDiscoveryWarnings(ctx, shownDiscoveryWarnings, warnings);
      if (active.length > 0) {
        lines.push(
          "",
          "⚠ Active subagents detected. Do not poll crew_list; results arrive automatically.",
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("crew_list")), 0, 0);
    },
    renderResult(result, _options, _theme, _context) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
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
      return toolSuccess(`Subagent '${subagent.name}' spawned as ${id}.`, {
        id,
      });
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
        return toolSuccess(
          `Aborted ${abortedIds.length} subagent(s): ${abortedIds.join(", ")}`,
          { ids: abortedIds },
          { terminate: true },
        );
      }

      const ids = params.subagent_id
        ? [params.subagent_id]
        : (params.subagent_ids ?? []);
      const result = crew.abortOwned(ids, callerSessionId, {
        reason: "Aborted by tool request",
      });
      const message = formatAbortToolMessage(result);
      if (result.abortedIds.length === 0) {
        throw new Error(message || "No subagents were aborted.");
      }
      return toolSuccess(
        message,
        {
          ids: result.abortedIds,
          missing_ids: result.missingIds,
          foreign_ids: result.foreignIds,
        },
        { terminate: true },
      );
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
          "ID of the subagent awaiting an owner action (from crew_list or crew_spawn result)",
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
      return toolSuccess(
        `Message sent to subagent ${params.subagent_id}. Response will be delivered asynchronously.`,
        { id: params.subagent_id },
      );
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
      return toolSuccess(`Subagent ${params.subagent_id} closed.`, {
        id: params.subagent_id,
      });
    },
    renderCall(args, theme, _context) {
      return renderCrewCall(theme, "crew_done", args.subagent_id || "...");
    },
  });
}
