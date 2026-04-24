# pi-crew Architecture

This document explains the technical architecture of `@melihmucuk/pi-crew`, focusing on what makes this extension unique.

For pi fundamentals, see pi docs: `extensions.md`, `sdk.md`, `session.md`. Project-level guardrails are in `AGENTS.md`.

## 1. What pi-crew adds

`pi-crew` is a non-blocking subagent orchestration extension. It lets one pi session delegate work to isolated subagent sessions without blocking the caller. Results are delivered back as `crew-result` custom messages.

Primary components:

- `extension/runtime/crew-runtime.ts` - Process-level singleton owning all subagent state
- `extension/runtime/subagent-registry.ts` - In-memory subagent registry
- `extension/runtime/delivery-coordinator.ts` - Owner-based result routing
- `extension/runtime/overflow-recovery.ts` - Context overflow retry tracking for subagent prompts
- `extension/bootstrap-session.ts` - Subagent session construction with extension filtering
- `extension/agent-discovery.ts` - Subagent definition discovery and validation

## 2. Core runtime components

### 2.1 CrewRuntime singleton

`CrewRuntime` is a process-level singleton that survives pi runtime replacement (`/resume`, `/new`, `/fork`, `/reload`). When pi discards an old extension instance and creates a new one, the new instance reconnects to the same `crewRuntime` and picks up existing subagent state.

Responsibilities:

- Create subagent state records
- Bootstrap isolated subagent sessions
- Run subagent prompt cycles with overflow recovery
- Transition subagents between states
- Deliver results to owner sessions

### 2.2 Delivery coordinator

Routes subagent results to the correct session at the correct time. Key behaviors:

- Tracks active session via `ActiveRuntimeBinding` (set on `session_start`, cleared on `session_shutdown`)
- Queues results when owner session is inactive
- Flushes queued results when owner session activates on any `session_start`; resume/fork are the important replacement paths because subagents survive runtime replacement within the same process
- Uses `triggerTurn: false/true` split to preserve ordering between `crew-result` and `crew-remaining`

Underlying delivery: see pi's `sendMessage({ deliverAs, triggerTurn })` in extensions.md.

`crew_list` uses the same idle/streaming delivery rules for its `crew-list-warning` custom message when active subagents exist. The warning is separate from tool output so the list remains a one-time snapshot while anti-polling guidance is delivered as a visible message.

### 2.3 Overflow recovery

Subagent prompt cycles are wrapped by overflow recovery tracking. The tracker observes `agent_end`, `compaction_start`, `compaction_end`, `auto_retry_start`, and `auto_retry_end` events to distinguish normal completion from context-overflow compaction and retry.

Outcomes:

- No overflow observed → prompt outcome is based on the final assistant message.
- Overflow compaction completes with retry and the retry reaches a terminal `agent_end` → recovered; prompt outcome is based on the final assistant message.
- Overflow handling times out, is cancelled, or compaction does not retry → failed; the subagent settles as `error` unless the final assistant message already reported an error.

### 2.4 Subagent registry

In-memory, process-scoped: `Map<subagentId, SubagentState>`

- Owner session filtering
- Runtime ID generation (`<name>-<hex>`)

Does not persist across process restarts. Subagent session files remain for post-hoc inspection.

## 3. Session bootstrapping

When `crew_spawn` executes:

1. Resolve subagent definition from discovery sources
2. Resolve model (fallback to caller session model if invalid)
3. Resolve tools, skills
4. Create `DefaultResourceLoader` with `extensionsOverride` that excludes `pi-crew`
5. Call `sessionManager.newSession({ parentSession })` for parent-child linkage
6. Create `AgentSession` with resolved configuration
7. Send task prompt asynchronously

**Extension filtering:** Subagent sessions must not load `pi-crew` again. Prevents recursive orchestration loops.

## 4. Delivery model

### 4.1 Owner-based routing

Results belong to the session that spawned the subagent. Owner identity uses `getSessionId()`, not file path (in-memory sessions have undefined paths).

### 4.2 Idle vs streaming

Check owner session state before delivery:

- **Idle (`isIdle() = true`):** Send with `triggerTurn: true`
- **Streaming (`isIdle() = false`):** Send with `deliverAs: "steer"` and `triggerTurn: true`

Critical: `deliverAs: "steer"` to an idle session leaves the message unprocessed (no active turn loop).

### 4.3 Deferred flush

Pending message flush after `session_start` is deferred to next macrotask. Synchronous delivery loses custom message persistence (pi-core emits `session_start` before reconnecting agent listener during resume). While a flush is scheduled, new deliveries for that owner are queued so ordering is preserved.

### 4.4 TTL cleanup

Pending messages older than 24 hours are discarded during `flushPending`.

## 5. Subagent state lifecycle

### 5.1 States

- `running` - Actively processing
- `waiting` - Interactive subagent awaiting `crew_respond` or `crew_done`
- `done` - Completed successfully
- `error` - Failed with error
- `aborted` - Cancelled

### 5.2 State transitions

After prompt cycle completion, inspect assistant stop reason:

- `stopReason: "error"` → status `error`
- `stopReason: "aborted"` → status `aborted`
- Normal completion + `interactive: true` → status `waiting`
- Normal completion + non-interactive → status `done`

### 5.3 Interactive subagents

`interactive: true` subagents enter `waiting` after each response. They accept follow-up messages via `crew_respond` until explicitly closed with `crew_done`. Closing does NOT emit a duplicate `crew-result`.

### 5.4 Tool completion behavior

`crew_respond` returns immediately and delivers the subagent response asynchronously. Successful `crew_abort` results terminate the current tool turn after aborting owned subagents.

## 6. Ownership and isolation

Invariants:

1. `crew_list`, `crew_abort`, `crew_respond`, `crew_done`, status widget: session-scoped. Only owner sees/controls.
2. `/pi-crew-abort`: cross-session emergency escape hatch.
3. `session_shutdown` always deactivates delivery binding. On replacement paths (`reload`, `new`, `resume`, `fork`), subagents continue running. On `quit`, the extension aborts all running subagents. `SIGINT` also aborts via a process hook, and `beforeExit` remains a fallback.

## 7. Subagent definition model

Discovery priority:

1. Project: `<cwd>/.pi/agents/*.md`
2. User global: `~/.pi/agent/agents/*.md`
3. Bundled: `agents/` in package

Higher priority wins. Same-name duplicates in same directory produce warning.

Frontmatter: `name`, `description`, `model`, `thinking`, `tools`, `skills`, `compaction`, `interactive`

Tools/skills semantics:

- **Omitted:** Use full supported allowlist
- **Empty list (`tools: []`):** Grant none

JSON overrides: `~/.pi/agent/pi-crew.json` (global), `<cwd>/.pi/pi-crew.json` (project). Project wins.

## 8. Behavioral invariants

1. Spawned subagent must not block caller session.
2. Results route to owning session (by ID), not currently active session.
3. Subagent sessions must not load `pi-crew`.
4. `crew_respond` returns immediately; result delivered asynchronously.
5. `crew_done` cleans up only; no duplicate result message.
6. Queued results flush when owner session becomes active.
7. `crew-result` messages appear before `crew-remaining` notes (ordering via `triggerTurn` split).
8. `crew-list-warning` is delivered as a separate custom message when `crew_list` is called while the owner has active subagents.
9. Pending messages preserved for inactive sessions; TTL (24h) prevents memory leak.
10. Active subagent state survives runtime replacement within same process.
11. Graceful quit aborts subagents through `session_shutdown.reason === "quit"`; replacement paths do not.

## 9. Reading guide

1. `README.md` - Product surface
2. `AGENTS.md` - Architecture guardrails
3. `extension/index.ts` - Session event wiring
4. `extension/runtime/crew-runtime.ts` - Orchestration, state transitions
5. `extension/runtime/delivery-coordinator.ts` - Owner routing, queueing
6. `extension/bootstrap-session.ts` - Session construction
7. `extension/agent-discovery.ts` - Definition validation
8. `extension/integration/` - Tools, command, renderers

## 10. Verification

```bash
npm run typecheck
npm run build
```