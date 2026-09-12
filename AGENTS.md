# AGENTS.md

## Project Overview

pi-crew provides non-blocking subagent orchestration for the Pi coding agent. It runs bounded tasks in isolated SDK sessions, routes results back to the session that spawned them, and keeps successful subagents alive for follow-up turns. The critical outcome is reliable background work without blocking the owner session or mixing results between sessions.

## Key Files / Folders

- `extension/index.ts` — Extension entry point; session activation and shutdown, process cleanup, tool registration, and renderer registration.
- `extension/crew.ts` — `CrewRuntime`; owns state, ownership, delivery queueing, aborts, and lifecycle transitions.
- `extension/subagent-session.ts` — SDK session creation, capability isolation, and prompt-cycle outcomes.
- `extension/subagent-status.ts` — Lifecycle status vocabulary: the status values and their phases (`in-flight`, `awaiting-owner`, `terminal`), plus the tool-activity vocabulary.
- `extension/subagent-result.ts` — Universal result contract, `crew_report` tool, and cycle result acceptance.
- `extension/catalog.ts` — Agent definition and config discovery, parsing, overrides, and warning semantics.
- `extension/task.ts` — Source of truth for the structured task schema, validation, and child-prompt formatting.
- `extension/tools.ts` — Public registration and invocation boundary for the `crew_*` tools.
- `extension/tool-activity.ts` — Sanitizes and summarizes tool activity for display.
- `extension/mentions.ts` — Inline `@crew:name` autocomplete and model-context-only mention expansion.
- `extension/delivery.ts` — Result delivery policy, model-bound result messages, and the TUI-only abort entry.
- `extension/format.ts` — Model-id parsing and display formatting helpers.
- `extension/ui.ts` — Renderers and the session-bound status widget.
- `tests/` — Behavior contracts for the catalog, task contract, runtime, tools, lifecycle wiring, mentions, UI, sanitization, and package metadata.
- `package.json` — Source of truth for shipped and Pi-registered resources.

## Development Invariants

- Preserve the ownership boundaries listed in Key Files / Folders. Do not add wrappers without a seam where behavior genuinely varies.
- `crew_spawn.task` must remain a closed `goal` / `context` / `instructions` assignment: `goal` and every array item are non-blank, `context` may be empty, and `instructions` has at least one item. Reject unknown fields, flat strings, and legacy conversion; preserve task values when formatting the child prompt.
- `CrewRuntime` must remain process-global; delivery and widget bindings must be rebound for the active owner session. A runtime-version mismatch on reload aborts the stale runtime's subagents before replacing it.
- Subagent sessions must filter out pi-crew through `extensionsOverride` and link to the owner with `SessionManager.newSession({ parentSession })`. Do not automatically delete subagent session files.
- Create each child `ModelRuntime` with model-network access disabled. Snapshot owner provider registrations and transfer only authentication required by the configured model, or by the owner's current model when no model is configured; credential transfer must not enable network access.
- Run prompt cycles directly with `AgentSession.prompt()`; do not add custom context-overflow recovery.
- `crew_report` is the universal successful-result boundary; `report` is the complete role-specific final answer, not a prelude to another summary. Preserve the closed result schema, cycle-local final-call acceptance, and one-reminder policy specified in `docs/result-protocol.md#successful-results` when changing result validation or prompt cycles.
- Lifecycle statuses are `running`, `completed`, `needs_input`, `error`, and `aborted`, defined once in `extension/subagent-status.ts` with their phase (`in-flight`, `awaiting-owner`, `terminal`). Compare phases, never raw status values, and keep one presentation table in `extension/ui.ts` keyed by those statuses. Each successful prompt cycle settles into its `crew_report` outcome; `completed` and `needs_input` stay abortable and visible as active until explicit `crew_done`, which disposes the session directly. Settling a prompt cycle disposes the session automatically only for terminal statuses.
- Tool-activity statuses are a separate vocabulary, defined once as `SUBAGENT_TOOL_STATUS` in `extension/subagent-status.ts`; they are never lifecycle statuses. A `crew_report` call counts toward the tool-call total but never occupies a retained activity row, so protocol mechanics cannot evict real activity from the widget.
- Subagent working time counts prompt cycles only: add the cycle duration to `workedMs` when a cycle settles, restart `runningSince` on spawn and respond, and never count waiting for an owner action. The status widget shows that total per agent, presents the outcome as an icon instead of repeating a status label, and prints the toggle hint once per render. The `widget.showToolCalls` config is presentation-only: when false it hides tool-activity rows and the toggle hint while keeping status, usage, and call/failure totals, and it never changes tool execution or activity recording.
- Always use `sessionManager.getSessionId()` for ownership. `getSessionFile()` is not owner identity.
- `crew_respond` may only restart an owned subagent in the `awaiting-owner` phase and must return without waiting for the prompt; a subagent with no attached session settles as an error instead of blocking the tool. `crew_done` may only close an owned subagent in the `awaiting-owner` phase and must not send a message. Aborts may target only owned abortable subagents and must preserve missing and foreign-ID reporting.
- `crew_spawn` and `crew_respond` are non-blocking. `crew_list` is only for discovery or a status snapshot; never poll it for completion because results arrive asynchronously.
- Inline `@crew:name` references identify a user-selected subagent but do not require spawning; sentence intent controls delegation. Mention names are limited to ASCII letters, digits, and hyphens; filter other discovered names from autocomplete without narrowing catalog or tool validity, and never partially expand unsupported names. Expand every syntactically valid reference in user text to `<pi-crew subagent="name" />` only in model-bound context, without catalog lookup or mutation of stored text or image content.
- Route results to the owner session that spawned the subagent and queue results while that owner is inactive. Defer activation flushes to the next macrotask and drop pending messages older than 24 hours during flush.
- `/fork` and `/clone` re-parent the previous session's `in-flight` and `awaiting-owner` subagents and their queued results to the new session id, matched by the previous session file; no other `session_start` reason adopts anything.
- `completed`, `needs_input`, and `error` results are delivered as model-visible messages with `{ deliverAs: "steer", triggerTurn: true }`: a steer queues into a running turn and an idle owner gets a turn that delivers it, so the owner session's streaming state never changes pi-crew's policy. Every such delivered result triggers an owner turn, so no result may be deferred while peers are still running. `aborted` is recorded with `pi.appendEntry("crew-abort")` instead — TUI-only, no model context, no turn — because the owner already knows from the `crew_abort` tool result or is shutting down. Both kinds go through the same owner-routing queue. Any prompt template that combines a batch of results must gate the next stage on every spawned agent having settled.
- Keep result model context and TUI presentation separate: model-bound content is JSON with `subagent_id`, `brief`, and the exact validated `result` (or terminal `status`/`error`), while the renderer builds Markdown cards only from structured details. Do not copy a display body into message details or expose protocol wrappers in the card.
- Every `session_shutdown` deactivates delivery. `reload`, `new`, `resume`, and `fork` preserve background work; only `quit` aborts it. The `beforeExit` hook also aborts all subagents. Do not register process signal handlers or exit the process from the extension; pi owns signal handling and shutdown.
- Discover agent definitions in priority order: project agents, user agents, then bundled agents. Higher-priority sources win silently; duplicate names within one source warn. Project agents and the project `pi-crew.json` are loaded only when `ctx.isProjectTrusted()` is true; otherwise both are skipped with a single discovery warning.
- Merge `pi-crew.json` overrides in user-then-project order; project fields win while unspecified user fields remain. When changing tool-list parsing or merging, preserve the definition/override delta, reset, ordering, and warning rules in `docs/configuration.md#tool-deltas`.
- Models use `provider/model-id`. A configured model must resolve exactly or the subagent fails before prompting; only an omitted model inherits the spawning-session model. Wrong-typed fields warn and are ignored in both `.md` definitions and `pi-crew.json`; a malformed model string warns at discovery but keeps its raw value, so the spawn still fails. Omitted `tools` means the default built-in tool set; omitted `skills` means all discovered skills; an explicit empty list means none. Tool allowlists may include extension-registered custom Pi tools, so do not validate them against a fixed built-in list.
- Treat tool arguments as untrusted display data and route widget targets through `summarizeToolTarget`. Keep summaries single-line and control-sequence-free, redact recognized sensitive keys and authentication/flag forms, and strip HTTP(S) query and fragment data. This is not a complete secret detector.
- Bundled resources must be included in npm `files`. Pi extensions, skills, and prompts must also appear in the `pi` manifest; bundled agent definitions belong only in the npm package.
- Test observable public behavior. Use the `CrewRuntime` `createRunner` seam for subagent lifecycle tests; add seams only where production behavior genuinely varies.
- Ask before adding dependencies, CI checks, baselines, ratchets, or broad enforcement.

## Commands

- `npm run typecheck` — Type-check the extension and test TypeScript sources.
- `npm test` — Run the behavior suite with the Node test runner.

## Read When Relevant

- When changing user-facing installation, tool behavior, agent discovery or config, or packaged resources, read `README.md`. For discovery or config, also read `docs/configuration.md`; for result validation, lifecycle, delivery, or model-context presentation, read `docs/result-protocol.md`.
- When changing bundled delegation behavior, orchestration guidance, or `crew_*` tool prompt guidance, read `skills/pi-crew/SKILL.md` together with the relevant tool definitions.
- When changing the structured task contract or child-prompt formatting, read `README.md`, `skills/pi-crew/SKILL.md`, all bundled `agents/*.md` definitions, and both `prompts/pi-crew-*.md` orchestration templates.
- When changing planning orchestration or scout/planner contracts, read `prompts/pi-crew-plan.md` and the relevant `agents/scout.md` and `agents/planner.md` definitions.
- When changing review orchestration or reviewer contracts, read `prompts/pi-crew-review.md` and the relevant reviewer definitions under `agents/`.
- When changing a bundled subagent's capabilities, lifecycle, or output format, read its `agents/*.md` definition and any prompt that references it.
- When changing custom-agent authoring guidance or supported definition fields, read `skills/pi-crew/references/create-agent.md` and `docs/configuration.md`.
- When maintaining `AGENTS.md`, keep only durable, non-obvious, implementation-shaping rules. Do not add one-off preferences or details owned by another source. If code conflicts with this file, report the conflict instead of silently leaving stale guidance.
