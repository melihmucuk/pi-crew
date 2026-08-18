# pi-crew

Non-blocking subagent orchestration for [pi](https://pi.dev). Run isolated subagents in parallel while your current session stays interactive. Updates return automatically to the session that started them.

## Preview

![pi-crew running parallel subagents](assets/preview.png)

## Install

From npm:

```bash
pi install npm:@melihmucuk/pi-crew
```

From git:

```bash
pi install git:github.com/melihmucuk/pi-crew
```

This installs the extension, orchestration skill, prompt templates, and bundled subagents. pi-crew requires Pi 0.82.1 or newer.

## How It Works

Once installed, pi-crew exposes these capabilities in your pi session:

### Tools

#### `crew_list`

Lists available subagents and the active subagents owned by the current session, including each subagent's capabilities and whether it supports follow-up messages.

#### `crew_spawn`

Spawns a subagent in an isolated background session. Each spawn needs a short `brief` label and a structured, self-contained `task`. Results return automatically to the Pi session that started the work. If that session is inactive, results are queued for up to 24 hours.

```json
{
  "subagent": "scout",
  "brief": "map authenticated API endpoints",
  "task": {
    "goal": "All authenticated API endpoints and their authentication methods are identified.",
    "context": ["The user needs this inventory before changing the authorization model."],
    "instructions": [
      "Find every API endpoint and trace its authentication checks.",
      "Report relevant paths, symbols, relationships, and discovery gaps."
    ]
  }
}
```

`goal` states the required end result, `context` carries task-relevant owner-session facts unavailable to the isolated subagent, and `instructions` lists the concrete task-specific actions. Put approved plans in `instructions` verbatim, or reference their readable source file. In the TUI, expand the `crew_spawn` tool call to review the complete task as rendered Markdown.

#### `crew_abort`

Aborts one, many, or all active subagents owned by the current session.

Supported modes:

- single: `subagent_id`
- multiple: `subagent_ids`
- all active in current session: `all: true`

```
"abort scout-a1b2"
"abort scout-a1b2 and worker-c3d4"
"abort all active subagents"
```

#### `crew_respond`

Sends a follow-up message to an interactive subagent owned by the current session that is waiting for a response. Interactive subagents stay alive after their initial response, allowing multi-turn conversations.

```
"respond to planner-a1b2 with: yes, use the existing auth middleware"
```

#### `crew_done`

Closes a waiting interactive subagent when you no longer need follow-up messages.

```
"close planner-a1b2, the plan looks good"
```

### Prompt Templates

#### `/pi-crew-plan`

Expands a bundled prompt template that orchestrates discovery and planning for implementation tasks.
Use it to spawn scout subagents to investigate the codebase, then delegate to a planner subagent to produce a step-by-step implementation plan.

The required `scout` and `planner` definitions are bundled with pi-crew.

#### `/pi-crew-review`

Expands a bundled prompt template that orchestrates parallel code and quality reviews.
Use it to review provided or default changed-code scope with `code-reviewer` and `quality-reviewer`, using structured tasks that carry intent, expected behavior, and relevant references, then merge both results into one report.

The required `code-reviewer` and `quality-reviewer` definitions are bundled with pi-crew.

### Skills

#### `pi-crew`

A bundled orchestration skill for writing self-contained tasks, coordinating parallel work, handling results, and managing interactive subagents.

## Bundled Subagents

pi-crew ships with six subagent definitions that cover common workflows:

| Subagent             | Purpose                                                                                          | Tools         | Interactive |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------- | ----------- |
| **scout**            | Discovers and maps relevant code. Read-only; not for review or planning.                          | read, bash    | No          |
| **planner**          | Creates implementation plans. Read-only; use only when the user asks for a plan.                 | read, bash    | Yes         |
| **oracle**           | Advises on high-impact decisions and trade-offs. Read-only; not for routine review or planning.  | read, bash    | Yes         |
| **code-reviewer**    | Reviews code changes for bugs and correctness. Read-only.                                        | read, bash    | No          |
| **quality-reviewer** | Reviews code changes for maintainability and complexity. Read-only; use only when this focus is requested. | read, bash    | No          |
| **worker**           | Implements and verifies code changes. Not for review, discovery, or planning.                    | all built-ins | Yes         |

Read-only bundled subagents still keep `bash` for inspection workflows like `git` and `ast-grep`. This is an instruction-level contract, not a sandbox boundary.

## Subagent Discovery

Subagent definitions are discovered from three locations, in priority order:

1. **Project**: Pi's project config agents directory (default: `<cwd>/.pi/agents/*.md`)
2. **User global**: Pi's agent directory (default: `~/.pi/agent/agents/*.md`)
3. **Bundled**: shipped with this package

When multiple sources define a subagent with the same `name`, the higher-priority source wins. This lets you override any bundled subagent by placing a file with the same name in your project or user directory.

## Custom Subagents

Create `.md` files in Pi's project config agents directory (default: `<cwd>/.pi/agents/`) or global agent directory (default: `~/.pi/agent/agents/`) with YAML frontmatter:

```markdown
---
name: my-subagent
description: What this subagent does
model: anthropic/claude-haiku-4-5
thinking: medium
tools: read, grep, find, ls, bash
skills: skill-1, skill-2
---

Your system prompt goes here. This is the body of the markdown file.

The subagent will follow these instructions when executing tasks.
```

### Frontmatter Fields

| Field         | Required | Description                                                                                                          |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | Subagent identifier. No whitespace, use hyphens.                                                                     |
| `description` | yes      | Shown in `crew_list` output.                                                                                         |
| `model`       | no       | `provider/model-id` format (e.g., `anthropic/claude-haiku-4-5`). If omitted, uses the owner's current model.         |
| `thinking`    | no       | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.                                           |
| `tools`       | no       | Comma-separated list or YAML array of built-in or extension-registered Pi tool names. Omit for all built-ins; use an empty value or list for none. |
| `skills`      | no       | Comma-separated list or YAML array of skill names (e.g., `ast-grep`). Omit for all; use an empty value or list for none. |
| `compaction`  | no       | Enable context compaction. Defaults to `true`.                                                                       |
| `interactive` | no       | Keep session alive after response for multi-turn conversations. Defaults to `false`.                                 |

Subagents use the owner's Pi model configuration and credentials. A configured model must be available under its exact `provider/model-id`; otherwise the subagent fails before sending a prompt. The owner's current model is used only when the `model` field is omitted. Custom tools are available when their registering extension is also loaded in the child session; pi-crew itself is excluded to prevent recursive delegation.

## Subagent Overrides via JSON

You can override selected frontmatter fields without editing the `.md` definition files.

Config locations follow Pi's directories:

- Global: `<agentDir>/pi-crew.json` (default: `~/.pi/agent/pi-crew.json`)
- Project: `<cwd>/<CONFIG_DIR_NAME>/pi-crew.json` (default: `<cwd>/.pi/pi-crew.json`)

Project config overrides global config. Only these fields are overridable:

- `model`
- `thinking`
- `tools`
- `skills`
- `compaction`
- `interactive`

`name` and `description` cannot be overridden.

Example:

```json
{
  "agents": {
    "scout": {
      "model": "anthropic/claude-haiku-4-5",
      "tools": ["read", "bash"],
      "interactive": false
    },
    "planner": {
      "thinking": "high"
    }
  }
}
```

Override values replace the matching frontmatter fields for the named subagent after discovery. Unknown subagent names and invalid override values are ignored with warnings in `crew_list` output.

## Status Widget

When the current session owns active subagents, the TUI shows their task labels, elapsed time, lifecycle state, tool-call and failure counts, cumulative input/output tokens and cost, and recent tool activity. Tool rows use safe, compact targets and result summaries where available; raw tool arguments and output are never shown.

On session replacement paths such as `/new`, `/resume`, `/fork`, and `/reload`, subagents keep running and reconnect when their owner session becomes active again. Quitting Pi aborts active subagents.

```
⠋ planner-e5f6 - plan config changes | Ctrl+Shift+E  details
  gpt-5.4 · high | ↑ 16.4k · ↓ 2.2k · $0.05
  running 18s · 6 tool calls · showing latest 3
  ---
  read  README.md:208-240 · 33 lines
```

`↑` and `↓` show cumulative input and output tokens for the child session; `$` shows its cumulative cost. Model and thinking settings remain visible in both modes. Interactive subagents waiting for a response show a ⏳ icon beside their ID and `waiting for response` in the activity line. Summary mode shows the latest three calls; details mode shows the latest ten. If the total exceeds the visible window, the activity line says `showing latest 3` or `showing latest 10` after any failure count, rather than implying unavailable history can be expanded.

## Acknowledgments

Inspired by these projects:

- [pi-subagents](https://github.com/nicobailon/pi-subagents) by [@nicobailon](https://github.com/nicobailon)
- [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) by [@HazAT](https://github.com/HazAT)

## License

MIT
