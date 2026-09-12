# Configuration

## Subagent Discovery

Subagent definitions are discovered in priority order:

1. **Project**: Pi's project config agents directory (default: `<cwd>/.pi/agents/*.md`)
2. **User global**: Pi's agent directory (default: `~/.pi/agent/agents/*.md`)
3. **Bundled**: shipped with this package

When multiple sources define the same `name`, the higher-priority source wins. Override a bundled subagent by placing a file with the same name in your project or user directory.

Project-local subagents and `pi-crew.json` load only when the project is trusted (Pi's project trust prompt, or `defaultProjectTrust`). In an untrusted project they are skipped with a discovery warning; user and bundled resources still load.

## Custom Subagents

Create a `.md` file in the project or global agents directory with YAML frontmatter:

```markdown
---
name: my-subagent
description: What this subagent does
model: anthropic/claude-haiku-4-5
thinking: medium
tools: read, grep, find, ls, bash
skills: skill-1, skill-2
---

Your system prompt goes here. The subagent follows these instructions when executing tasks.
```

### Frontmatter Fields

| Field         | Required | Description                                                                                                                                                                                                              |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | yes      | Subagent identifier. No whitespace; use hyphens.                                                                                                                                                                         |
| `description` | yes      | Role description shown in `crew_list`.                                                                                                                                                                                   |
| `model`       | no       | `provider/model-id`, e.g. `anthropic/claude-haiku-4-5`. Omit to use the owner's current model.                                                                                                                           |
| `thinking`    | no       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.                                                                                                                                                            |
| `tools`       | no       | Comma-separated list or YAML array of built-in or extension-registered Pi tool names. Omit for all built-ins (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`); use an empty value or list for none. |
| `skills`      | no       | Comma-separated list or YAML array of skill names. Omit for all discovered skills; use an empty value or list for none.                                                                                                  |
| `compaction`  | no       | Enable context compaction. Defaults to `true`.                                                                                                                                                                           |

Subagents use the owner's Pi model configuration and credentials. A configured model must be available under its exact `provider/model-id`; otherwise the subagent fails before prompting. Only an omitted model inherits the owner's current model.

Custom tools are available when their registering extension also loads in the child session. pi-crew itself is excluded to prevent recursive delegation. Read-only agents can still have `bash`: their read-only behavior is an instruction-level contract, not a sandbox boundary.

## JSON Overrides

Override selected frontmatter fields without editing definitions:

- Global: `<agentDir>/pi-crew.json` (default: `~/.pi/agent/pi-crew.json`)
- Project: `<cwd>/<CONFIG_DIR_NAME>/pi-crew.json` (default: `<cwd>/.pi/pi-crew.json`)

Overrides apply in user-then-project order. Project fields win; unspecified user fields remain. Only `model`, `thinking`, `tools`, `skills`, and `compaction` can be overridden, not `name` or `description`.

```json
{
  "agents": {
    "scout": {
      "model": "anthropic/claude-haiku-4-5",
      "tools": ["read", "bash"]
    },
    "planner": {
      "thinking": "high"
    }
  }
}
```

Override values replace the matching fields after discovery, except for tool deltas described below. Unknown agent names and wrong-typed override values are ignored with warnings in `crew_list`. A malformed model string is kept and warned about; spawning fails until it is fixed.

### Tool Deltas

Prefix tool names with `+` or `-` to add or remove tools without restating the list:

```json
{
  "agents": {
    "scout": { "tools": ["+web_search", "+web_fetch"] },
    "worker": { "tools": ["-write"] }
  }
}
```

- A delta applies to the definition's tool list, or to all built-ins when `tools` is omitted.
- A list must contain only deltas or only plain names. Mixed lists are ignored with a warning.
- Removing a tool that is not present is a no-op.
- Entries apply in written order: `["+web_search", "-web_search"]` ends without `web_search`.
- Deltas also work in `.md` frontmatter, where they apply to the built-in set.
- User and project overrides compose in that order; a plain list resets the tool list.

## Widget Settings

The `widget` and `agents` fields are independent; a config file may contain either or both:

```json
{
  "widget": {
    "showToolCalls": false
  }
}
```

`widget.showToolCalls` defaults to `true`. Setting it to `false` hides recent tool-activity rows and the details/collapse shortcut hint. Status, working time, tokens, cost, and call/failure totals remain visible. Tool execution and activity recording are unchanged.

Project settings override global settings, and untrusted project config is not loaded. Config changes apply on `/reload`.
