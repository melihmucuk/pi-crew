# AGENTS.md

## Project Overview

pi-crew provides non-blocking subagent orchestration for the Pi coding agent. It runs bounded tasks in isolated SDK sessions, routes results back to the session that spawned them, and keeps interactive subagents alive across follow-up turns. The critical outcome is reliable background work without blocking the owner session or mixing results between sessions.

## Key Files / Folders

- `extension/index.ts` — Extension entry point; session activation and shutdown, process cleanup, tool registration, and renderer registration.
- `extension/crew.ts` — `CrewRuntime`; owns state, ownership, delivery queueing, aborts, and the interactive lifecycle.
- `extension/subagent-session.ts` — SDK session creation, capability isolation, and prompt-cycle outcomes.
- `extension/catalog.ts` — Agent definition and config discovery, parsing, overrides, and warning semantics.
- `extension/tools.ts` — Public validation and invocation boundary for the `crew_*` tools.
- `extension/ui.ts` — `crew-result` delivery policy, renderers, and the session-bound status widget.
- `tests/` — Behavior contracts for the catalog, runtime, tools, lifecycle wiring, and package metadata.
- `package.json` — Source of truth for shipped and Pi-registered resources.

## Key Decisions / Invariants

- Keep orchestration in `crew.ts`, SDK session mechanics in `subagent-session.ts`, discovery and config in `catalog.ts`, tools in `tools.ts`, UI and delivery in `ui.ts`, and hook wiring in `index.ts`. Do not add shallow wrappers or pass-through layers without a seam where behavior genuinely varies.
- `CrewRuntime` must remain process-global; delivery and widget bindings must be rebound for the active owner session.
- Subagent sessions must filter out pi-crew through `extensionsOverride` and link to the owner with `SessionManager.newSession({ parentSession })`. Do not automatically delete subagent session files.
- Run prompt cycles directly with `AgentSession.prompt()`; do not add custom context-overflow recovery.
- The only states are `running`, `waiting`, `done`, `error`, and `aborted`. Only `running` and `waiting` are abortable and visible as active.
- Normal interactive completion becomes `waiting`; normal non-interactive completion becomes `done`; error and aborted stop reasons become their corresponding terminal states.
- Always use `sessionManager.getSessionId()` for ownership. `getSessionFile()` is not owner identity.
- `crew_respond` may only restart an owned `waiting` subagent with an active session, and must return without waiting for the prompt. `crew_done` may only close an owned `waiting` subagent and must not send a message. Aborts may target only owned abortable subagents and must preserve missing and foreign-ID reporting.
- Route results to the owner session that spawned the subagent and queue results while that owner is inactive. Defer activation flushes to the next macrotask and drop pending messages older than 24 hours during flush.
- Send idle sessions `{ triggerTurn }` and streaming sessions `{ deliverAs: "steer", triggerTurn }`. Intermediate `done` results must not trigger an idle turn while another subagent is running; `waiting` interactive results must always trigger one.
- Every `session_shutdown` deactivates delivery. `reload`, `new`, `resume`, and `fork` preserve background work; only `quit` aborts it. Use `session_shutdown.reason` and event metadata directly for replacement detection; do not infer transitions with timeout flags or pre-switch hooks. Keep `SIGINT`, quit, and `beforeExit` cleanup paths and abort reasons distinct.
- Discover agent definitions in priority order: project config agents, user agents, then bundled agents. Higher-priority sources win silently; duplicate names within one source warn.
- Models use `provider/model-id`; invalid or unavailable model configuration falls back to the spawning-session model. Omitted `tools` or `skills` means all built-ins; an explicit empty list means none. Interactive agents remain `waiting` after successful turns until `crew_done`.
- Bundled resources must be included in npm `files`. Pi extensions, skills, and prompts must also appear in the `pi` manifest; bundled agent definitions belong only in the npm package.
- Test public behavior surfaces. Use the `CrewRuntime` runner seam for subagent lifecycle tests; do not create test seams for obsolete pass-through internals.
- Ask before adding dependencies, CI checks, baselines, ratchets, or broad enforcement.

## Commands

- `npm run typecheck` — Type-check the extension and test TypeScript sources.
- `npm test` — Run the behavior suite with the Node test runner.

## Read When Relevant

- When changing user-facing installation, tool behavior, agent discovery or config, or packaged resources, read `README.md`.
- When changing bundled delegation behavior, orchestration guidance, or `crew_*` tool prompt guidance, read `skills/pi-crew/SKILL.md` together with the relevant tool definitions.
- When changing planning orchestration or scout/planner contracts, read `prompts/pi-crew-plan.md` and the relevant `agents/scout.md` and `agents/planner.md` definitions.
- When changing review orchestration or reviewer contracts, read `prompts/pi-crew-review.md` and the relevant reviewer definitions under `agents/`.
- When changing a bundled subagent's capabilities, lifecycle, or output format, read its `agents/*.md` definition and any prompt that references it.
- When a release is requested, read `.pi/prompts/release.md`; obtain required approval before dependency updates, commits, tags, pushes, or publishing.
- When maintaining `AGENTS.md`, keep only durable, non-obvious, implementation-shaping rules. Do not add one-off preferences or details owned by another source. If code conflicts with this file, report the conflict instead of silently leaving stale guidance.
