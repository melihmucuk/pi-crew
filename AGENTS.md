# AGENTS.md

## Development Invariants

- Preserve existing ownership boundaries. Do not add wrappers without a seam where behavior genuinely varies.
- Keep `crew_spawn.task` a closed `goal` / `context` / `instructions` assignment; reject unknown fields, flat strings, and legacy conversion, and preserve task values when formatting the child prompt.
- Keep `CrewRuntime` process-global and rebind delivery and widgets to the active owner session; abort stale subagents before replacing a runtime whose version differs on reload.
- Filter pi-crew out of child sessions through `extensionsOverride` and link children with `SessionManager.newSession({ parentSession })`. Do not automatically delete subagent session files.
- Create each child `ModelRuntime` with model-network access disabled. Snapshot owner provider registrations and transfer only authentication required by the configured model, or by the owner's current model when no model is configured; credential transfer must not enable network access.
- Run prompt cycles directly with `AgentSession.prompt()`; do not add custom context-overflow recovery.
- Compare lifecycle phases, never raw status values; keep lifecycle and tool-activity vocabularies separate and one lifecycle presentation table in `extension/ui.ts`.
- Count `crew_report` toward tool-call totals, but never retain it as an activity row: protocol mechanics must not evict real activity.
- Keep Herdr presentation-only, without changing official Pi lifecycle or session identity; outside its required TUI/environment, do no integration work. Count process-wide in-flight work, serialize reports, retain only the latest pending count, and replace pending counts with a final clear on shutdown.
- Always use `sessionManager.getSessionId()` for ownership. `getSessionFile()` is not owner identity.
- Treat inline subagent mentions as user selection, not unconditional delegation; expand them only in model-bound user text, without catalog lookup or mutation of stored text or images.
- Defer owner activation flushes to the next macrotask.
- Do not register process signal handlers or exit the process from the extension; Pi owns signal handling and shutdown.
- Treat tool arguments as untrusted display data and route widget targets through `summarizeToolTarget`; keep summaries single-line and control-sequence-free, preserve recognized-key/authentication/flag redaction and HTTP(S) query/fragment stripping, and do not treat this as a complete secret detector.
- Use the `CrewRuntime` `createRunner` seam for subagent lifecycle tests; add seams only where production behavior genuinely varies.
- Ask before adding CI checks, baselines, ratchets, or broad enforcement.
- Keep README feature descriptions brief: user-visible behavior and required setup only. Leave implementation details out.
- If code conflicts with this file, report the conflict instead of silently leaving stale guidance.

## Read When Relevant

- When changing user-facing installation, tool behavior, agent discovery or config, or packaged resources, read `README.md`. For discovery or config, also read `docs/configuration.md`; for result validation, lifecycle, delivery, or model-context presentation, read `docs/result-protocol.md`.
- When changing bundled delegation behavior, orchestration guidance, or `crew_*` tool prompt guidance, read `skills/pi-crew/SKILL.md` together with the relevant tool definitions.
- When changing the structured task contract or child-prompt formatting, read `README.md`, `skills/pi-crew/SKILL.md`, all bundled `agents/*.md` definitions, and both `prompts/pi-crew-*.md` orchestration templates.
- When changing planning orchestration or scout/planner contracts, read `prompts/pi-crew-plan.md` and the relevant `agents/scout.md` and `agents/planner.md` definitions.
- When changing review orchestration or reviewer contracts, read `prompts/pi-crew-review.md` and the relevant reviewer definitions under `agents/`.
- When changing a bundled subagent's capabilities, lifecycle, or output format, read its `agents/*.md` definition and any prompt that references it.
- When changing custom-agent authoring guidance or supported definition fields, read `skills/pi-crew/references/create-agent.md` and `docs/configuration.md`.
