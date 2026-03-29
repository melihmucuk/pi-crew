import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "./agents.js";
import { CrewManager } from "./runner.js";
import { updateWidget } from "./widget.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  const crewManager = new CrewManager(extensionDir);

  let currentCtx: ExtensionContext | undefined;
  const shownDiscoveryWarnings = new Set<string>();

  const notifyDiscoveryWarnings = (
    ctx: ExtensionContext,
    warnings: { filePath: string; message: string }[],
  ) => {
    if (!ctx.hasUI) return;

    for (const warning of warnings) {
      const key = `${warning.filePath}:${warning.message}`;
      if (shownDiscoveryWarnings.has(key)) continue;

      shownDiscoveryWarnings.add(key);
      ctx.ui.notify(`${warning.message} (${warning.filePath})`, "error");
    }
  };

  const refreshWidget = () => {
    if (currentCtx) updateWidget(currentCtx, crewManager);
  };

  crewManager.onWidgetUpdate = refreshWidget;

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    refreshWidget();
  });

  pi.on("session_switch", (_event, ctx) => {
    currentCtx = ctx;
    refreshWidget();
  });

  pi.on("session_shutdown", () => {
    crewManager.abortAll(pi);
  });

  // =========================================================================
  // Tools
  // =========================================================================

  pi.registerTool({
    name: "crew_list",
    label: "List Crew",
    description:
      "List available agent definitions (from ~/.pi/agent/agents/*.md) and currently running agents with their status.",
    parameters: Type.Object({}),
    promptSnippet: "List agent definitions and running agents",

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { agents, warnings } = discoverAgents();
      notifyDiscoveryWarnings(ctx, warnings);
      const running = crewManager.getRunning();

      const lines: string[] = [];

      lines.push("## Available agents");
      if (agents.length === 0) {
        lines.push(
          "No valid agent definitions found. Add `.md` files to `~/.pi/agent/agents/`.",
        );
      } else {
        for (const a of agents) {
          const parts = [a.name, a.description];
          if (a.model) parts.push(`model: ${a.model}`);
          if (a.tools) parts.push(`tools: ${a.tools.join(", ")}`);
          if (a.skills) parts.push(`skills: ${a.skills.join(", ")}`);
          lines.push(`- **${parts[0]}** — ${parts.slice(1).join(" | ")}`);
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
      lines.push("## Running agents");
      if (running.length === 0) {
        lines.push("No agents currently running.");
      } else {
        for (const s of running) {
          lines.push(
            `- **${s.id}** — agent: ${s.agentConfig.name}, task: ${s.task.slice(0, 80)}${s.task.length > 80 ? "..." : ""}, turns: ${s.turns}, status: ${s.status}`,
          );
        }
      }

      const text = lines.join("\n");
      return { content: [{ type: "text", text }], details: {} };
    },

    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("crew_list")), 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });

  pi.registerTool({
    name: "crew_spawn",
    label: "Spawn Crew",
    description:
      "Spawn a non-blocking agent that runs in an isolated session. The agent works independently while the main session stays interactive. Results are delivered as steering messages when done. Use crew_list first to see available agents.",
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
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents, warnings } = discoverAgents();
      notifyDiscoveryWarnings(ctx, warnings);
      const agent = agents.find((a) => a.name === params.agent);

      if (!agent) {
        const available = agents.map((a) => a.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Unknown agent: "${params.agent}". Available: ${available}`,
            },
          ],
          isError: true,
          details: {},
        };
      }

      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const id = crewManager.spawn(
        agent,
        params.task,
        ctx.cwd,
        parentSessionFile,
        ctx,
        pi,
      );

      return {
        content: [
          {
            type: "text",
            text: `Agent '${agent.name}' spawned as ${id}. Result will be delivered as a steering message when done.`,
          },
        ],
        details: { id },
      };
    },

    renderCall(args, theme, _context) {
      const agentName = args.agent || "...";
      const taskPreview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      const text =
        theme.fg("toolTitle", theme.bold("crew_spawn ")) +
        theme.fg("accent", agentName) +
        theme.fg("dim", ` "${taskPreview}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const text = result.content[0];
      return new Text(
        text?.type === "text" ? theme.fg("success", text.text) : "(no output)",
        0,
        0,
      );
    },
  });

  // =========================================================================
  // Command: /crew-abort
  // =========================================================================

  pi.registerCommand("crew-abort", {
    description: "Abort a running agent",

    getArgumentCompletions(argumentPrefix) {
      const running = crewManager.getRunning();
      if (running.length === 0) return null;
      return running
        .filter((s) => s.id.startsWith(argumentPrefix))
        .map((s) => ({
          value: s.id,
          label: `${s.id} (${s.agentConfig.name})`,
        }));
    },

    async handler(args, ctx) {
      const trimmed = args.trim();

      if (trimmed) {
        const success = crewManager.abort(trimmed, pi);
        if (!success) {
          ctx.ui.notify(`No running agent with id "${trimmed}"`, "error");
        } else {
          ctx.ui.notify(`Agent ${trimmed} aborted`, "info");
        }
        return;
      }

      const running = crewManager.getRunning();
      if (running.length === 0) {
        ctx.ui.notify("No running agents", "info");
        return;
      }

      const options = running.map((s) => ({
        id: s.id,
        label: `${s.id} (${s.agentConfig.name})`,
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

  // =========================================================================
  // Message Renderer: crew-result
  // =========================================================================

  pi.registerMessageRenderer("crew-result", (message, { expanded }, theme) => {
    const details = message.details as
      | { agentId: string; agentName: string; error?: boolean }
      | undefined;

    const isError = details?.error ?? false;
    const agentLabel = details
      ? `${details.agentName} (${details.agentId})`
      : "agent";

    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const header = `${icon} ${theme.fg("toolTitle", theme.bold(agentLabel))}`;

    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(header, 0, 0));

    if (message.content) {
      const content = String(message.content);
      if (expanded) {
        box.addChild(new Text("", 0, 0));
        box.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
      } else {
        const preview = content.split("\n").slice(0, 5).join("\n");
        box.addChild(new Text(theme.fg("dim", preview), 0, 0));
        if (content.split("\n").length > 5) {
          box.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
        }
      }
    }

    return box;
  });
}
