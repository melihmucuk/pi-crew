# AGENTS.md

## Purpose

- Non-blocking subagent orchestration extension for pi coding agent.
- Each subagent runs in an isolated SDK session; results are delivered as steering messages to the owner session that spawned them.
- Interactive subagents (`interactive: true`) stay alive after responding and support multi-turn conversations via `crew_respond` / `crew_done`.

## Reference

- Detailed runtime architecture reference: `./docs/architecture.md`

## Rules / Guardrails

### Architecture

- Subagent sessions must filter out the pi-crew extension via `extensionsOverride`. Removing the filter lets a subagent call `crew_spawn` again, creating an infinite loop.
- Link parent sessions with `SessionManager.newSession({ parentSession })`. Do not use `AgentSession.newSession()` — it disconnects/aborts/resets the subagent.
- Subagent session files are intentionally never cleaned up. They enable post-hoc inspection via `/resume`. Do not add automatic cleanup.

### Message Delivery

- Results must be routed to the owner session, not the currently active session. If the owner session is not active, queue the result and deliver on `session_start` when that owner becomes active.
- Check the owner session's streaming state before sending a subagent result. Use `{ triggerTurn: true }` when `isIdle() = true`, and `{ deliverAs: "steer", triggerTurn: true }` when `isIdle() = false`. Sending `deliverAs: "steer"` to an idle session causes the message to sit unprocessed because there is no active turn loop.
- Subagent completion always sends the same steering message format: subagent name, id, status, and final message. Whether the subagent is interactive or not does not change this message; it only determines whether the session stays open.
- `crew_respond` must be fire-and-forget. Blocking the caller session defeats the purpose of interactive subagents. Validate, return immediately, and deliver the result via steering message.
- `crew_done` only performs cleanup (dispose + remove from map). It must not send a steering message because the last subagent response was already delivered in the previous turn. Sending it again produces a duplicate message and an unnecessary turn.
- Pending message flush in `activateSession` must be deferred to the next macrotask (`setTimeout`). Pi-core's `resume()` emits `session_start` with `reason: "resume"` before reconnecting the agent event listener; synchronous delivery in that handler emits events on a disconnected listener, losing JSONL persistence for the custom message.
- When other subagents for the same owner are still running, send a separate `crew-remaining` message after the `crew-result`. If the owner session is idle, queue the result first without triggering, then queue the remaining note with `triggerTurn: true` so the next turn sees both messages in order. If the owner session is already streaming, queue the remaining note after the result. Do not embed the remaining count in the result message itself.
- Abort result messages must reflect the actual source. Use distinct reasons for tool-triggered aborts, command-triggered aborts, and shutdown cleanup. Do not hardcode a generic "Aborted by user" message for all paths.

### Session Isolation

- Owner identity must use `sessionManager.getSessionId()`, not `getSessionFile()`. `getSessionFile()` returns `undefined` for in-memory sessions, causing all unsaved sessions to share the same owner identity.
- Each subagent is owned by the session that spawned it. `crew_list`, `crew_abort`, `crew_respond`, `crew_done`, `session_shutdown`, and the status widget must restrict access to the owner session. Removing or bypassing ownership checks causes cross-session subagent interference.
- `crew_abort` must only abort subagents owned by the current session. It supports single-id, multi-id, and abort-all modes.
- `/pi-crew-abort` is intentionally unrestricted — it serves as an emergency escape hatch across all sessions. Do not add ownership checks to it.

### Session Lifecycle

- `session_shutdown` must always deactivate delivery (`deactivateSession`). On replacement paths (`reload`, `new`, `resume`, `fork`), stop there. On `quit`, also abort running subagents. Pi now provides `session_shutdown.reason` (`quit | reload | new | resume | fork`) plus optional `targetSessionFile`; use that metadata directly instead of pre-switch hacks.
- Shutdown cleanup is split by source: `SIGINT` aborts via the process hook, Pi-managed graceful quit paths abort via `session_shutdown.reason === "quit"`, and `beforeExit` remains a fallback.
- Avoid `setTimeout` flags to track session transitions. Pi's extension hooks can `await` and cause the flag to expire before `session_shutdown` fires. Instead, rely on `session_shutdown` reason handling plus `flushPending` for message delivery.
- Pending messages are preserved for inactive sessions. Use TTL-based cleanup (24 hours) to prevent unbounded memory growth. Messages older than TTL are discarded during `flushPending`.

### Subagent Definitions

- Subagent definitions are discovered from three locations in priority order: project (`<cwd>/.pi/agents/`), user global (`~/.pi/agent/agents/`), bundled (`agents/` in the package). When the same name exists in multiple sources, the higher-priority source wins silently. Duplicate names within the same directory produce a warning.
- The `model` field must use `provider/model-id` format (e.g., `anthropic/claude-haiku-4-5`). Values without `/` are ignored and the spawning session's model is used instead.
- When `tools`/`skills` are omitted in frontmatter, the subagent gets access to all built-in tools/skills. An explicit empty list (`tools: []` or `tools:`) means no access. Do not conflate absent fields with empty fields.
- `interactive: true` subagents keep their session alive after each response. The caller must close them with `crew_done`; otherwise the session stays in memory.

## Verification

```bash
npm run typecheck
npm run build
```
