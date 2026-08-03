# AGENTS.md

## Project Overview

pi-crew provides non-blocking subagent orchestration for the Pi coding agent. It runs bounded tasks in isolated SDK sessions, routes results back to the session that spawned them, and keeps interactive subagents alive across follow-up turns. The critical outcome is reliable background work without blocking the owner session or mixing results between sessions.

## Key Files / Folders

- `extension/index.ts` — Extension entry point; session activation and shutdown, process cleanup, tool registration, and renderer registration.
- `extension/crew.ts` — `CrewRuntime`; owns state, ownership, delivery queueing, aborts, and the interactive lifecycle.
- `extension/subagent-session.ts` — SDK session creation, capability isolation, and prompt-cycle outcomes.
- `extension/catalog.ts` — Agent definition and config discovery, parsing, overrides, and warning semantics.
- `extension/task.ts` — Source of truth for the structured task schema, validation, and child-prompt formatting.
- `extension/tools.ts` — Public registration and invocation boundary for the `crew_*` tools.
- `extension/tool-activity.ts` — Sanitizes and summarizes tool activity for display.
- `extension/ui.ts` — Result delivery policy, renderers, and the session-bound status widget.
- `tests/` — Behavior contracts for the catalog, task contract, runtime, tools, lifecycle wiring, UI, sanitization, and package metadata.
- `package.json` — Source of truth for shipped and Pi-registered resources.

## Development Invariants

- Keep orchestration in `extension/crew.ts`, SDK session mechanics in `extension/subagent-session.ts`, task schema/validation/formatting in `extension/task.ts`, discovery and config in `extension/catalog.ts`, public tool boundaries in `extension/tools.ts`, tool-activity sanitization and summarization in `extension/tool-activity.ts`, UI and delivery in `extension/ui.ts`, and hook wiring in `extension/index.ts`. Do not add wrappers without a seam where behavior genuinely varies.
- `crew_spawn.task` must remain a closed `goal` / `context` / `instructions` assignment: `goal` and every array item are non-blank, `context` may be empty, and `instructions` has at least one item. Reject unknown fields, flat strings, and legacy conversion; preserve task values when formatting the child prompt.
- `CrewRuntime` must remain process-global; delivery and widget bindings must be rebound for the active owner session.
- Subagent sessions must filter out pi-crew through `extensionsOverride` and link to the owner with `SessionManager.newSession({ parentSession })`. Do not automatically delete subagent session files.
- Create each child `ModelRuntime` with model-network access disabled. Snapshot owner provider registrations and transfer only authentication required by the configured model, or by the owner's current model when no model is configured; credential transfer must not enable network access.
- Run prompt cycles directly with `AgentSession.prompt()`; do not add custom context-overflow recovery.
- The only states are `running`, `waiting`, `done`, `error`, and `aborted`. Only `running` and `waiting` are abortable and visible as active.
- Normal interactive completion becomes `waiting`; normal non-interactive completion becomes `done`; error and aborted stop reasons become their corresponding terminal states.
- Always use `sessionManager.getSessionId()` for ownership. `getSessionFile()` is not owner identity.
- `crew_respond` may only restart an owned `waiting` subagent with an active session and must return without waiting for the prompt. `crew_done` may only close an owned `waiting` subagent and must not send a message. Aborts may target only owned abortable subagents and must preserve missing and foreign-ID reporting.
- `crew_spawn` and `crew_respond` are non-blocking. `crew_list` is only for discovery or a status snapshot; never poll it for completion because results arrive asynchronously.
- Route results to the owner session that spawned the subagent and queue results while that owner is inactive. Defer activation flushes to the next macrotask and drop pending messages older than 24 hours during flush.
- Send idle sessions `{ triggerTurn }` and streaming sessions `{ deliverAs: "steer", triggerTurn }`. Intermediate `done` results must not trigger an idle turn while another subagent is running; `waiting` interactive results must always trigger one.
- Every `session_shutdown` deactivates delivery. `reload`, `new`, `resume`, and `fork` preserve background work; only `quit` aborts it. `SIGINT` and `beforeExit` also abort all subagents; `SIGINT` exits with code 130.
- Discover agent definitions in priority order: project agents, user agents, then bundled agents. Higher-priority sources win silently; duplicate names within one source warn.
- Merge `pi-crew.json` overrides in user-then-project order. Project fields win while unspecified user fields remain.
- Models use `provider/model-id`. A configured model must resolve exactly or the subagent fails before prompting; only an omitted model inherits the spawning-session model. Invalid overrides are ignored. Omitted `tools` means the default built-in tool set; omitted `skills` means all discovered skills; an explicit empty list means none. Tool allowlists may include extension-registered custom Pi tools, so do not validate them against a fixed built-in list. Interactive agents remain `waiting` after successful turns until `crew_done`.
- Treat tool arguments as untrusted display data and route widget targets through `summarizeToolTarget`. Keep summaries single-line and control-sequence-free, redact recognized sensitive keys and authentication/flag forms, and strip HTTP(S) query and fragment data. This is not a complete secret detector.
- Bundled resources must be included in npm `files`. Pi extensions, skills, and prompts must also appear in the `pi` manifest; bundled agent definitions belong only in the npm package.
- Test observable public behavior. Use the `CrewRuntime` `createRunner` seam for subagent lifecycle tests; add seams only where production behavior genuinely varies.
- Ask before adding dependencies, CI checks, baselines, ratchets, or broad enforcement.

## Commands

- `npm run typecheck` — Type-check the extension and test TypeScript sources.
- `npm test` — Run the behavior suite with the Node test runner.

## Read When Relevant

- When changing user-facing installation, tool behavior, agent discovery or config, or packaged resources, read `README.md`.
- When changing bundled delegation behavior, orchestration guidance, or `crew_*` tool prompt guidance, read `skills/pi-crew/SKILL.md` together with the relevant tool definitions.
- When changing the structured task contract or child-prompt formatting, read `README.md`, `skills/pi-crew/SKILL.md`, all bundled `agents/*.md` definitions, and both `prompts/pi-crew-*.md` orchestration templates.
- When changing planning orchestration or scout/planner contracts, read `prompts/pi-crew-plan.md` and the relevant `agents/scout.md` and `agents/planner.md` definitions.
- When changing review orchestration or reviewer contracts, read `prompts/pi-crew-review.md` and the relevant reviewer definitions under `agents/`.
- When changing a bundled subagent's capabilities, lifecycle, or output format, read its `agents/*.md` definition and any prompt that references it.
- When maintaining `AGENTS.md`, keep only durable, non-obvious, implementation-shaping rules. Do not add one-off preferences or details owned by another source. If code conflicts with this file, report the conflict instead of silently leaving stale guidance.
