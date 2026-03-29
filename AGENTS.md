# AGENTS.md

## Purpose

- Non-blocking subagent orchestration extension for pi coding agent.
- Each subagent runs in an isolated SDK session; results are delivered as steering messages to the main session.

## Rules / Guardrails

### Architecture

- Subagent sessions must filter out the pi-crew extension via `extensionsOverride`. Removing the filter lets a subagent call `crew_spawn` again, creating an infinite loop.
- Link parent sessions with `SessionManager.newSession({ parentSession })`. Do not use `AgentSession.newSession()` — it disconnects/aborts/resets the agent.
- Subagent session files are intentionally never cleaned up. They enable post-hoc inspection via `/resume`. Do not add automatic cleanup.

### Agent Definitions

- The `model` field must use `provider/model-id` format (e.g., `anthropic/claude-haiku-4-5`). Values without `/` are ignored and the main session's model is used instead.
- When `tools`/`skills` are omitted in frontmatter, the subagent gets access to all built-in tools/skills. Restrict explicitly if needed.

## Verification

```bash
npm run typecheck
npm run build
```
