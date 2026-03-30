# pi-crew

Non-blocking subagent orchestration for [pi](https://pi.dev). Spawn isolated subagents that work in parallel while your current session stays interactive. Results are delivered back to the session that spawned them as steering messages when done.

## Install

```bash
pi install @melihmucuk/pi-crew
```

## How It Works

pi-crew adds five tools and one command to your pi session:

### `crew_list`

Lists available subagent definitions and currently running subagents.

### `crew_spawn`

Spawns a subagent in an isolated session. The subagent runs in the background with its own context window, tools, and skills. When it finishes, the result is delivered to the session that spawned it as a steering message that triggers a new turn. If that session is not active, the result is queued until you switch back to it.

```
"spawn scout and find all API endpoints and their authentication methods"
```

### `crew_abort`

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

Tool-triggered aborts are reported back as steering messages with the reason `Aborted by tool request`.

### `crew_respond`

Sends a follow-up message to an interactive subagent that is waiting for a response. Interactive subagents stay alive after their initial response, allowing multi-turn conversations.

```
"respond to planner-a1b2 with: yes, use the existing auth middleware"
```

### `crew_done`

Closes an interactive subagent session when you no longer need it. This disposes the session and frees memory.

```
"close planner-a1b2, the plan looks good"
```

### `/crew-abort`

Aborts a running subagent. Supports tab completion for subagent IDs.
Unlike the `crew_abort` tool, this command is intentionally unrestricted and works as an emergency escape hatch across sessions.

## Bundled Subagents

pi-crew ships with five subagent definitions that cover common workflows:

| Subagent             | Purpose                                                                                                                  | Tools                      | Model             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ----------------- |
| **scout**            | Investigates codebase and returns structured findings. Read-only. Use before planning or implementing to gather context. | read, grep, find, ls, bash | claude-haiku-4-5  |
| **planner**          | Analyzes requirements and produces a step-by-step implementation plan. Read-only. Does not write code. Interactive.      | read, grep, find, ls, bash | gpt-5.4           |
| **code-reviewer**    | Reviews code changes for bugs, security issues, and correctness. Read-only. Does not fix issues.                         | read, grep, find, ls, bash | gpt-5.4           |
| **quality-reviewer** | Reviews code structure for maintainability, duplication, and complexity. Read-only. Does not look for bugs.              | read, grep, find, ls, bash | gpt-5.4           |
| **worker**           | Implements code changes, fixes, and refactors autonomously. Has full read-write access to the codebase.                  | all                        | claude-sonnet-4-6 |

Read-only bundled subagents still keep `bash` for inspection workflows like `git` and `ast-grep`. This is an instruction-level contract, not a sandbox boundary.

## Bundled Subagents Setup

`pi install` only registers the extension. The bundled subagent definitions need to be copied to `~/.pi/agent/agents/` manually:

```bash
mkdir -p ~/.pi/agent/agents && cp "$(npm root -g)/@melihmucuk/pi-crew/agents/"*.md ~/.pi/agent/agents/
```

Existing subagent files with the same name will be overwritten. Custom subagents in the same directory are not affected.

## Custom Subagents

Create `.md` files in `~/.pi/agent/agents/` with YAML frontmatter:

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

| Field         | Required | Description                                                                                     |
| ------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `name`        | yes      | Subagent identifier. No whitespace, use hyphens.                                                |
| `description` | yes      | Shown in `crew_list` output.                                                                    |
| `model`       | no       | `provider/model-id` format (e.g., `anthropic/claude-haiku-4-5`). Falls back to session default. |
| `thinking`    | no       | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.                             |
| `tools`       | no       | Comma-separated list: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Omit for all, use empty value for none. |
| `skills`      | no       | Comma-separated skill names (e.g., `ast-grep`). Omit for all, use empty value for none.         |
| `compaction`  | no       | Enable context compaction. Defaults to `true`.                                                  |
| `interactive` | no       | Keep session alive after response for multi-turn conversations. Defaults to `false`.            |

## Status Widget

When subagents are running, a live status widget appears in the TUI for the current owner session, showing each subagent's ID, model, turn count, and context token usage.

```
⠹ scout-a1b2 (claude-haiku-4-5) · turn 3 · 12.5k ctx
⠸ worker-c3d4 (claude-sonnet-4-6) · turn 7 · 45.2k ctx
⏳ planner-e5f6 (gpt-5.4) · turn 2 · 8.3k ctx
```

Interactive subagents waiting for a response show a ⏳ icon instead of a spinner.

## License

MIT
