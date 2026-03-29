# AGENTS.md

## Purpose

- Non-blocking subagent orchestration extension for pi coding agent.
- Each subagent runs in an isolated SDK session; results are delivered as steering messages to the owner session that spawned them.
- Interactive subagents (`interactive: true`) stay alive after responding and support multi-turn conversations via `crew_respond` / `crew_done`.

## Rules / Guardrails

### Architecture

- Subagent sessions must filter out the pi-crew extension via `extensionsOverride`. Removing the filter lets a subagent call `crew_spawn` again, creating an infinite loop.
- Link parent sessions with `SessionManager.newSession({ parentSession })`. Do not use `AgentSession.newSession()` — it disconnects/aborts/resets the agent.
- Subagent session files are intentionally never cleaned up. They enable post-hoc inspection via `/resume`. Do not add automatic cleanup.

### Message Delivery

- Results must be routed to the owner session, not the currently active session. If the owner session is not active, queue the result and deliver on `session_switch` or `session_fork` when that owner becomes active. On `session_shutdown`, purge queued messages for the closing session to prevent memory leaks.
- Check the owner session's streaming state before sending a subagent result. Use `{ triggerTurn: true }` when `isIdle() = true`, and `{ deliverAs: "steer", triggerTurn: true }` when `isIdle() = false`. Sending `deliverAs: "steer"` to an idle session causes the message to sit unprocessed because there is no active agent loop.
- Subagent completion always sends the same steering message format: agent name, id, status, and final message. Whether the agent is interactive or not does not change this message; it only determines whether the session stays open.
- `crew_respond` must be fire-and-forget. Blocking the caller session defeats the purpose of interactive agents. Validate, return immediately, and deliver the result via steering message.
- `crew_done` only performs cleanup (dispose + remove from map). It must not send a steering message because the last agent response was already delivered in the previous turn. Sending it again produces a duplicate message and an unnecessary turn.
- When other agents for the same owner are still running, send a separate `crew-remaining` message. If the owner session is idle, inject the hidden remaining note before the result so the triggered turn sees both messages. If the owner session is already streaming, queue the remaining note after the result. Do not embed the remaining count in the result message itself.

### Session Isolation

- Owner identity must use `sessionManager.getSessionId()`, not `getSessionFile()`. `getSessionFile()` returns `undefined` for in-memory sessions, causing all unsaved sessions to share the same owner identity.
- Each subagent is owned by the session that spawned it. `crew_list`, `crew_respond`, `crew_done`, `session_shutdown`, and the status widget must restrict access to the owner session. Removing or bypassing ownership checks causes cross-session agent interference.
- `/crew-abort` is intentionally unrestricted — it serves as an emergency escape hatch across all sessions. Do not add ownership checks to it.

### Agent Definitions

- The `model` field must use `provider/model-id` format (e.g., `anthropic/claude-haiku-4-5`). Values without `/` are ignored and the spawning session's model is used instead.
- When `tools`/`skills` are omitted in frontmatter, the subagent gets access to all built-in tools/skills. An explicit empty list (`tools: []` or `tools:`) means no access. Do not conflate absent fields with empty fields.
- `interactive: true` agents keep their session alive after each response. The caller must close them with `crew_done`; otherwise the session stays in memory.

## Verification

```bash
npm run typecheck
npm run build
```
