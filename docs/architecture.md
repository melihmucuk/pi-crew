# pi-crew Architecture

This document explains the technical architecture of `@melihmucuk/pi-crew` for both human users and coding agents.

It describes runtime behavior, integration points, ownership rules, delivery semantics, and implementation boundaries. It intentionally avoids code snippets. Source files are referenced instead, because exact code can change while the behavioral contract should remain stable.

All paths in this document are relative to the repository root.

## 1. What the project is

`pi-crew` is a non-blocking subagent orchestration extension for pi.

Its job is to let one pi session delegate work to one or more isolated subagent sessions without blocking the caller session. Each spawned subagent runs independently, and its result is delivered back to the session that spawned it as a `crew-result` custom message. When the owner session is already streaming, that message is delivered as steering content.

At a high level, the system adds:

- tool-based orchestration for spawning, listing, aborting, responding to, and closing subagents
- a slash-command emergency abort path
- TUI renderers for subagent custom messages
- a live status widget for active subagents owned by the current session
- bundled subagent definitions and a bundled review prompt template

Primary entry points:

- `package.json`
- `extension/index.ts`
- `README.md`

## 2. Architectural goals

The extension is built around a few explicit goals:

1. **Keep the caller session interactive**
   The main session must not block while background work is happening.

2. **Preserve session isolation**
   Each subagent gets its own pi SDK session, context window, and resolved tool/skill set.

3. **Route results to the owning session**
   Results are not sent to whichever session happens to be active. They are sent to the session that created the subagent.

4. **Make multi-agent work understandable in the TUI**
   Users need visible state, clear completion messages, and an emergency stop path.

5. **Stay behavior-first**
   Agent definitions, tool restrictions, and delivery semantics are designed as explicit contracts, not incidental implementation details.

Project-level guardrails that define these contracts live in:

- `AGENTS.md`

## 3. Package layout and extension surface

### 3.1 Package registration in pi

`pi-crew` is packaged as a pi extension package.

Registration metadata lives in:

- `package.json`

Important package-level behaviors:

- `pi.extensions` points pi to the built extension entry at `./dist/index.js`
- `pi.prompts` exposes the bundled prompt template directory at `./prompts`
- `agents/` is shipped as package data and auto-discovered as the lowest-priority source during agent discovery

### 3.2 Repository structure

Main implementation areas:

- `extension/` - runtime extension logic
- `extension/runtime/` - in-memory state and delivery coordination
- `extension/integration/` - pi tool, command, and renderer registration
- `agents/` - bundled subagent definitions
- `prompts/` - bundled prompt templates

## 4. Core runtime components

### 4.1 Extension bootstrap

File:

- `extension/index.ts`

Responsibilities:

- instantiate one `CrewManager` for the extension runtime
- observe pi session lifecycle events
- activate delivery routing when the active pi session changes
- abort owned abortable subagents when an owner session shuts down
- register tools, command, and message renderers
- refresh the status widget when state changes

Session lifecycle events used by the extension:

- `session_start`
- `session_switch`
- `session_fork`
- `session_shutdown`

This is the bridge between pi core events and `pi-crew` runtime behavior.

### 4.2 Crew manager

File:

- `extension/crew-manager.ts`

`CrewManager` is the main orchestration service.

It owns the extension’s operational workflow:

- create subagent state records
- bootstrap isolated subagent sessions
- send prompts into subagent sessions
- interpret prompt outcomes
- transition subagents between `running`, `waiting`, `done`, `error`, and `aborted`
- deliver results back to the owner session
- enforce ownership checks for `respond`, `done`, and owned abort paths
- dispose finished subagents

In practice, `CrewManager` is the coordination layer above the registry and delivery subsystems.

### 4.3 Subagent registry

Files:

- `extension/runtime/subagent-registry.ts`
- `extension/runtime/subagent-state.ts`

Responsibilities:

- store live in-memory subagent state in a `Map`
- generate unique runtime IDs such as `<name>-<hex>`
- filter subagents by owner session
- provide summaries for the TUI widget and abort command
- count other still-running subagents for ordered delivery notes

Important architectural property:

- the registry is **in-memory only**
- active subagents are therefore runtime-scoped, not globally persistent across process restarts

However, per project rules, subagent session files themselves are intentionally not cleaned up, so post-hoc inspection through pi session history remains possible.

### 4.4 Delivery coordinator

File:

- `extension/runtime/delivery-coordinator.ts`

This component solves one of the most important architecture problems in the extension: **how to deliver background results to the correct session at the correct time**.

Responsibilities:

- track which pi session is currently active
- know whether the active owner session is idle or already streaming
- queue results for inactive owner sessions
- flush queued results when the owner session becomes active again
- preserve ordering between the main result message and the optional “remaining subagents” note

This separation keeps delivery logic independent from spawning logic.

## 5. Integration with pi

### 5.1 Registered tools

Files:

- `extension/integration/register-tools.ts`
- `extension/integration/tools/crew-list.ts`
- `extension/integration/tools/crew-spawn.ts`
- `extension/integration/tools/crew-abort.ts`
- `extension/integration/tools/crew-respond.ts`
- `extension/integration/tools/crew-done.ts`

The extension registers five tools:

- `crew_list`
- `crew_spawn`
- `crew_abort`
- `crew_respond`
- `crew_done`

These are the primary public API for LLM-driven orchestration.

Behavioral contracts:

- `crew_list` shows discovered subagent definitions and active subagents owned by the current session
- `crew_spawn` starts a non-blocking subagent owned by the current session
- `crew_abort` can abort one, many, or all active subagents owned by the current session
- `crew_respond` continues a waiting interactive subagent without blocking the caller session
- `crew_done` closes a waiting interactive subagent without emitting a duplicate completion message

### 5.2 Registered command

File:

- `extension/integration/register-command.ts`

The extension also registers the `/pi-crew:abort` command.

This command differs from `crew_abort` in one important way:

- it is intentionally unrestricted across sessions

It exists as an emergency escape hatch. This is a deliberate operational tool, not an ownership-safe automation surface.

### 5.3 Custom message renderers

Files:

- `extension/integration/register-renderers.ts`
- `extension/subagent-messages.ts`

The extension defines two custom message types:

- `crew-result`
- `crew-remaining`

These render in the TUI with custom formatting so asynchronous subagent output is readable and visually distinct from normal assistant text.

### 5.4 Status widget

File:

- `extension/status-widget.ts`

When the current session owns active subagents, a live widget shows:

- subagent ID
- the latest assistant-reported model name, or `…` before the first assistant turn ends
- turn count
- the latest `assistant.usage.totalTokens` value, displayed as `ctx`
- running vs waiting state

This widget is session-scoped. It only shows subagents owned by the currently active session.

## 6. Subagent definition model

### 6.1 Discovery sources and priority

File:

- `extension/agent-discovery.ts`

Subagent definitions are discovered from three directories in priority order:

1. **Project**: `<cwd>/.pi/agents/*.md`
2. **User global**: `~/.pi/agent/agents/*.md`
3. **Bundled**: `agents/` in the package

When the same subagent name exists in multiple sources, the higher-priority source wins silently. Duplicate names within the same directory produce a warning.

If a directory does not exist, it is skipped without warnings.

### 6.2 Definition format

Each subagent is a Markdown file with YAML frontmatter plus a Markdown body.

Frontmatter fields currently recognized by the runtime:

- `name`
- `description`
- `model`
- `thinking`
- `tools`
- `skills`
- `compaction`
- `interactive`

The Markdown body becomes appended system prompt content for the spawned subagent session.

### 6.3 JSON override sources and precedence

File:

- `extension/agent-discovery.ts`

After `.md` discovery, the runtime loads optional per-agent override config from two JSON files:

- global: `~/.pi/agent/pi-crew.json`
- project: `<cwd>/.pi/pi-crew.json`

Only these fields are overridable:

- `model`
- `thinking`
- `tools`
- `skills`
- `compaction`
- `interactive`

`name` and `description` are never overridable.

Merge behavior:

- global config is loaded first
- project config is loaded second
- project overrides global for the same subagent and field
- if both files define the same subagent, unspecified fields from global remain unless project overrides them

### 6.4 Validation and fallback behavior

Key behaviors implemented in discovery and bootstrap:

- missing or empty `name` or `description` makes the definition invalid and it is ignored
- names cannot contain whitespace
- later duplicate names are skipped once an earlier valid definition with the same name has been loaded
- `model` must use `provider/model-id` format to be considered valid
- invalid model format is ignored for model resolution with a warning
- invalid `thinking` values are ignored with a warning
- invalid `tools` or `skills` field formats produce a warning and are treated as empty lists in frontmatter
- unknown tools are filtered out with a warning
- unknown skills are not part of discovery validation; when `skills` is present, bootstrap filters against the loaded skill set, omits unknown names, and writes a `console.warn`
- non-boolean `compaction` or `interactive` values in frontmatter are ignored without a warning

Override-specific validation behavior:

- override entry value must be a JSON object
- unknown override fields produce warnings
- non-overridable fields (`name`, `description`) produce warnings
- invalid field types in overrides produce warnings and are ignored
- invalid `model`/`thinking` values in overrides produce warnings and are ignored
- invalid `tools`/`skills` formats in overrides produce warnings and are ignored
- unknown tool names in override `tools` produce warnings; valid names in the same list are still applied
- override entries for undiscovered subagent names produce warnings and are ignored

Important semantic distinction:

- omitted `tools` means “use the full supported tool allowlist”
- omitted `skills` means “do not install a `skillsOverride`, so all skills from the base resource loader remain available”
- explicit empty `tools` or `skills` means “grant none”

That distinction matters for both end users and coding agents authoring subagent definitions.

### 6.5 Supported tool set for spawned subagents

File:

- `extension/tool-registry.ts`

The current built-in tool allowlist for spawned subagents is:

- `read`
- `bash`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

Important limitation:

- tool restriction here is a pi tool-resolution choice, not an OS sandbox boundary
- for example, a “read-only” subagent remains read-only because of instruction and selected tool capabilities, not because of a kernel-level confinement model

## 7. Session bootstrapping and isolation

### 7.1 How a subagent session is created

File:

- `extension/bootstrap-session.ts`

When `crew_spawn` is executed, the runtime does not clone the current conversation directly. It creates a new agent session with explicit configuration.

Bootstrapping responsibilities:

- resolve the target model
- resolve the selected tool set
- construct a `DefaultResourceLoader`
- optionally filter skills
- append the subagent system prompt body
- create an in-memory settings manager for compaction settings
- create a new `SessionManager`
- call `sessionManager.newSession({ parentSession: parentSessionFile })` before creating the agent session
- create the actual `AgentSession`

### 7.2 Parent-child session linkage

A critical implementation rule is that the subagent session must be created through `SessionManager.newSession({ parentSession })`.

The current caller session file is passed when one exists. This is the supported way to preserve parent-child linkage for resumable sessions. Project rules explicitly forbid creating subagent sessions through the wrong session factory because it breaks lifecycle expectations.

Architectural rationale is documented in:

- `AGENTS.md`

### 7.3 Preventing recursive orchestration

One of the most important safety guards in the system is this:

- spawned subagent sessions must not load the `pi-crew` extension again

This is enforced by filtering the extension out through `extensionsOverride` inside the resource loader.

Why it matters:

- if a subagent can access `crew_spawn`, it can create more subagents
- that creates recursive or runaway orchestration loops
- preventing that at session bootstrap time is far safer than relying on prompt instructions alone

### 7.4 Model resolution

The runtime resolves models in two stages:

1. if the subagent definition does not specify a valid parsed model, the caller session model is reused
2. if a model is specified but not found in the active pi model registry, the runtime falls back to the caller session model and writes a `console.warn`

This keeps execution resilient to local model availability differences.

### 7.5 Compaction behavior

Each subagent session gets its own in-memory settings manager.

Behavior:

- `compaction` defaults to `true` if omitted
- a definition can explicitly disable it

This setting is applied per spawned session and does not reuse the caller session's compaction setting.

## 8. Spawn lifecycle

### 8.1 High-level flow

Relevant files:

- `extension/integration/tools/crew-spawn.ts`
- `extension/crew-manager.ts`
- `extension/bootstrap-session.ts`

Behavior sequence:

1. The `crew_spawn` tool handler calls `discoverAgents()` to load the current subagent definitions.
2. The requested subagent name is resolved against that discovery result.
3. The current session ID becomes the subagent owner ID.
4. `CrewManager.spawn()` creates a registry entry with status `running` and returns a runtime subagent ID immediately.
5. `CrewManager` starts asynchronous session bootstrap in the background.
6. Once bootstrapped, the new subagent session receives the task string as its prompt.
7. Completion or failure is delivered later as a `crew-result` custom message. If the owner session is already streaming, that message is delivered with `deliverAs: "steer"`.

This immediate-return plus background-execution split is the key non-blocking contract of the extension.

### 8.2 Runtime metrics during execution

`CrewManager` subscribes to subagent `turn_end` events.

Tracked metrics include:

- turn count, incremented on each `turn_end`
- the latest `assistant.usage.totalTokens` value seen on a `turn_end`
- the latest assistant-reported model name

These metrics power the status widget and active subagent summaries.

### 8.3 Prompt outcome interpretation

After a prompt cycle completes, the runtime inspects the last assistant message in the subagent session.

Outcome mapping:

- assistant stop reason `error` -> subagent status `error`
- assistant stop reason `aborted` -> subagent status `aborted`
- normal completion with `interactive: true` -> subagent status `waiting`
- normal completion with non-interactive definition -> subagent status `done`

This means interactive subagents and non-interactive subagents share the same prompt execution flow up to the final state transition.

## 9. Delivery model and message ordering

### 9.1 Owner-based routing

The most important delivery rule is:

- results belong to the session that spawned the subagent

They do not belong to:

- the currently visible session
- the most recent session
- the session that called a command later

Ownership identity is based on the current session ID, not the session file path. This matters because unsaved or in-memory sessions may not have stable file paths.

### 9.2 Immediate vs deferred delivery

Relevant files:

- `extension/runtime/delivery-coordinator.ts`
- `extension/index.ts`

Delivery branches:

- if the owner session is currently active, the result is sent immediately
- if the owner session is not active, the result is queued in memory until that session becomes active again

Queued results are flushed when the extension sees that owner session through:

- `session_start`
- `session_switch`
- `session_fork`

### 9.3 Idle vs streaming session behavior

pi requires different delivery semantics depending on whether the target session is idle or already processing output.

Behavioral rule for a `crew-result` when no separate remaining-note ordering is needed:

- idle owner session -> send with `triggerTurn: true`
- streaming owner session -> send as steering content with `deliverAs: "steer"` and `triggerTurn: true`

When an idle owner also needs a `crew-remaining` note, section 9.5 describes the deliberate `triggerTurn: false` / `true` split used to preserve message order.

Why this distinction exists:

- sending `deliverAs: "steer"` to an idle session can leave the message unprocessed because there is no active turn loop
- when the owner session is already streaming, the extension injects the result into that active turn as steering content instead of using the idle-session delivery path

This is one of the most subtle but important integration details in the extension.

### 9.4 Deferred flush timing

Pending message flush after session activation is intentionally deferred to the next macrotask.

Reason:

- pi-core can emit `session_switch` before reconnecting the agent listener during resume flows
- synchronous message delivery at that moment can lose custom message persistence

This is why queued results are flushed asynchronously instead of synchronously during session activation.

### 9.5 Result and remaining-note ordering

Files:

- `extension/subagent-messages.ts`
- `extension/runtime/delivery-coordinator.ts`

When a result is delivered and other subagents from the same owner are still in `running` state, the extension may send two messages:

1. the `crew-result`
2. a separate `crew-remaining` note

They are intentionally separate messages.

Why:

- the result message should stay focused on one subagent outcome
- the remaining count is transient orchestration state, not part of that result payload

Ordering guarantee:

- the result must appear before the remaining-note message

When the owner is idle and other subagents are still running, the extension sends the `crew-result` with `triggerTurn: false`, then sends the remaining note with `triggerTurn: true` so the next turn processes both in order.

When the owner is already streaming, the extension sends the `crew-result` first with `deliverAs: "steer"` and `triggerTurn: true`, then sends the `crew-remaining` note after it with `deliverAs: "steer"` and `triggerTurn: false`.

The remaining count is computed at send time from the current registry state, not stored in the `crew-result` payload.

## 10. Interactive subagents

### 10.1 Waiting state

Interactive subagents are defined with `interactive: true` in frontmatter.

After a successful prompt cycle, they transition to `waiting` instead of `done`.

Meaning of `waiting`:

- the session remains alive
- the subagent can receive follow-up messages
- the status widget shows a waiting icon rather than a spinner

### 10.2 `crew_respond`

Relevant files:

- `extension/integration/tools/crew-respond.ts`
- `extension/crew-manager.ts`

Behavior:

- validate that the subagent exists
- validate that it belongs to the caller session
- validate that it is in `waiting` state
- mark it `running`
- asynchronously send the follow-up prompt
- return immediately to the caller

This is deliberately fire-and-forget. The response comes later as another `crew-result` message.

### 10.3 `crew_done`

Relevant files:

- `extension/integration/tools/crew-done.ts`
- `extension/crew-manager.ts`

Behavior:

- validate existence, ownership, and `waiting` state
- dispose the session
- remove the subagent from the registry
- do **not** send another `crew-result` message

That last point is essential. The latest subagent response was already delivered when it entered `waiting`. Sending another completion custom message on `crew_done` would duplicate signal and create an unnecessary turn.

## 11. Abort semantics

### 11.1 Supported abort paths

There are three conceptually different abort sources:

1. tool-triggered aborts through `crew_abort`
2. unrestricted manual aborts through `/pi-crew:abort`
3. cleanup aborts when an owner session shuts down

Each path should report the real reason.

### 11.2 Owned abort behavior

Relevant files:

- `extension/integration/tools/crew-abort.ts`
- `extension/crew-manager.ts`

`crew_abort` supports exactly one mode per call:

- `subagent_id`
- `subagent_ids`
- `all: true`

It only operates on subagents owned by the current session.

The result separates:

- actually aborted IDs
- missing or already finished IDs
- IDs that belong to another session

### 11.3 Unrestricted command abort

Relevant file:

- `extension/integration/register-command.ts`

`/pi-crew:abort` can target any active abortable subagent, regardless of owner. This is not a bug. It is an explicit operational decision.

### 11.4 Session shutdown cleanup

Relevant file:

- `extension/index.ts`

On `session_shutdown`, the extension:

- aborts all abortable subagents currently owned by that session
- clears pending queued messages for that owner

This avoids memory leaks and prevents stale queued results from surviving after their owner session is gone.

## 12. Ownership and isolation rules

These are core architecture invariants, not optional conventions.

### 12.1 Owner identity

Owner identity uses the pi session ID.

Why:

- session file paths may be undefined for in-memory sessions
- file-path-based ownership can collapse multiple live sessions into the same logical owner

### 12.2 Session-scoped visibility

The following surfaces are ownership-restricted:

- `crew_list` active subagent section
- `crew_abort`
- `crew_respond`
- `crew_done`
- status widget
- owner cleanup on session shutdown

This prevents cross-session interference in normal tool-driven workflows.

### 12.3 What is intentionally not isolated

The emergency command `/pi-crew:abort` is intentionally cross-session.

This is the only major exception to normal ownership isolation.

## 13. User-facing message model

Relevant file:

- `extension/subagent-messages.ts`

Subagent outcome messaging is normalized into one common format.

Every `crew-result` payload includes:

- runtime subagent ID
- logical subagent name
- final status
- an optional body derived from the subagent result or error

In current completion and error paths, the runtime usually populates that body with assistant text, an error message, or `"(no output)"`.

`crew-remaining` is simpler. It carries display text only and does not attach structured `details`.

The `SubagentStatus` union currently includes:

- `running`
- `waiting`
- `done`
- `error`
- `aborted`

Current `crew-result` deliveries use `waiting`, `done`, `error`, or `aborted`. `running` is a live registry/widget state, not a completion message state.

## 14. Bundled subagents and prompt template

### 14.1 Bundled subagents

Files:

- `agents/scout.md`
- `agents/planner.md`
- `agents/worker.md`
- `agents/code-reviewer.md`
- `agents/quality-reviewer.md`

These are opinionated subagent definitions for common workflows.

They demonstrate how the extension is intended to be used:

- `scout` for quick investigation
- `planner` for interactive planning
- `worker` for implementation
- `code-reviewer` for correctness review
- `quality-reviewer` for maintainability review

Architecturally, these files are not special-cased by the runtime. They are auto-discovered as the lowest-priority source (priority 3) and go through the same discovery and bootstrap pipeline as project-level or user-level definitions. Users can override any bundled subagent by placing a same-named `.md` file in `<cwd>/.pi/agents/` or `~/.pi/agent/agents/`.

### 14.2 Bundled review orchestration prompt

File:

- `prompts/pi-crew:review.md`

This prompt template is a good example of how `pi-crew` is meant to be consumed by higher-level orchestration prompts.

It does not bypass the extension. Instead, it tells the orchestrating agent to gather review scope with normal repo inspection tools, then use the public `crew_*` tool surface to:

- verify required subagents exist
- spawn reviewers in parallel
- wait for both result messages
- merge results into a final report

This separation is important:

- the extension provides orchestration primitives
- prompts provide workflow policy

## 15. Failure handling and diagnostics

### 15.1 Discovery warnings

Relevant files:

- `extension/agent-discovery.ts`
- `extension/integration/register-tools.ts`

Invalid or partially invalid subagent definition files do not crash the extension.

Instead:

- discovery accumulates warnings
- `crew_list` includes those warnings in its text output
- `crew_list` and `crew_spawn` both trigger one-time UI notifications when a UI is available

This section covers discovery-time warnings only. Unknown skill names are warned later during bootstrap via `console.warn` in `extension/bootstrap-session.ts`.

This keeps misconfigured subagents visible without breaking healthy ones.

### 15.2 Bootstrap failures

Bootstrap failures are settled as subagent `error` results.

In practice, this covers exceptions thrown while preparing the resource loader or creating the subagent session.

The important behavior is that a failed spawn still resolves into a clear terminal subagent result rather than silently disappearing.

### 15.3 Prompt execution failures

Prompt-cycle failures are also normalized into terminal `error` or `aborted` outcomes and delivered through the same result channel.

This gives downstream orchestrators a single message model to watch, regardless of where the failure occurred.

## 16. What persists and what does not

### Persists

- extension package installation metadata
- bundled prompt template availability
- copied subagent definition files in `~/.pi/agent/agents/`
- pi session history files created for subagents

### Does not persist across process restarts

- in-memory active subagent registry
- in-memory pending delivery queue
- live status widget state

This distinction matters when designing higher-level workflows. `pi-crew` preserves session artifacts for inspection, but its live orchestration state is runtime-memory-based.

## 17. Behavioral invariants for future maintainers

These are the behaviors future changes must preserve:

1. A spawned subagent must not block the caller session.
2. Results must route to the owning session, not merely the currently active one.
3. Ownership must be based on session ID.
4. Subagent sessions must not load `pi-crew` again.
5. Interactive subagents must remain alive after responding until explicitly closed.
6. `crew_respond` must return immediately and deliver its result asynchronously later.
7. `crew_done` must clean up only and must not emit a duplicate result message.
8. When the owner session is inactive, result delivery must be queued and later flushed.
9. Result messages must appear before any “remaining subagents” note.
10. Session shutdown must abort owned abortable subagents and clear pending queued messages for that owner.
11. Tool ownership restrictions must remain strict, except for the emergency abort command.

These rules are the extension’s real architecture. File names may move, but these contracts should not.

## 18. Reading guide for coding agents

If you need to understand or change behavior, start in this order:

1. `README.md`
   Public product surface and user contract.

2. `AGENTS.md`
   Non-obvious architecture guardrails that must not regress.

3. `extension/index.ts`
   Extension bootstrap and session event wiring.

4. `extension/crew-manager.ts`
   Main orchestration and state transitions.

5. `extension/runtime/delivery-coordinator.ts`
   Owner routing, queueing, and turn-trigger behavior.

6. `extension/bootstrap-session.ts`
   Session construction, model/tool/skill resolution, and extension filtering.

7. `extension/agent-discovery.ts`
   Subagent definition semantics and validation rules.

8. `extension/integration/`
   pi-facing tools, command, and renderers.

9. `agents/` and `prompts/`
   Real workflow examples built on top of the runtime.

## 19. Verification

For implementation changes that affect runtime behavior, the project-level verification commands are:

- `npm run typecheck`
- `npm run build`

Source:

- `AGENTS.md`

For documentation-only changes, these commands are usually unnecessary unless the change is coupled with code edits.
