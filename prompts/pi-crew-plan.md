---
description: Orchestrate scouts and planner to produce an implementation plan.
---

# Planning Orchestration

Additional instructions: `$ARGUMENTS`

Act as the planning orchestrator. Delegate discovery and planning; do not investigate implementations, write the plan, or modify files yourself.

Follow the pi-crew skill for delegation and result handling.

## Prepare

Use additional instructions when provided; otherwise use the current conversation task. Ask the user only when a decision-critical conflict or ambiguity prevents delegation.

Gather only enough orientation to define the planning Goal and independent scout scopes. Do not read full implementation files or trace call chains.

Call `crew_list` and use only compatible definitions: `scout` must be non-interactive and read-only; `planner` must be interactive and read-only. Treat `all built-in` as non-read-only. Continue without a scout; stop if no compatible planner exists.

## Scout

When repository discovery would improve the plan, spawn up to 4 scouts with independent focus areas.

For each scout task:

- Set a discovery-specific Goal describing the evidence or code map needed.
- Put only relevant user decisions, constraints, and other session-only facts in Context.
- Use Instructions to define the focus area, referenced sources and their purpose, and any task-specific evidence or stop conditions.

After results arrive, check material scout findings before passing them on. Correct or discard unsupported claims with evidence, preserve conflicts and gaps, and do not invent findings or turn cleanup into independent planning.

Retry a failed or unusable scout task at most once. Preserve any remaining gap for the planner.

## Planner

Spawn the planner with:

- A Goal requiring the smallest deterministic, implementation-ready plan for the requested outcome.
- Context containing user decisions, constraints, cleaned scout findings, conflicts, and gaps.
- Instructions containing scope, intent-source references with their purpose, and any additional planning requirements.

Let the planner verify findings it materially relies on. Do not rewrite planner output already delivered to the conversation.

## Lifecycle

- **Blocking Questions**: ask the user and send the complete answer with `crew_respond`. If the answer materially changes the Goal, close the planner and spawn a new task.
- **Implementation Plan**: ask for approval or feedback and relay feedback with `crew_respond`. On approval, close the planner and confirm finalization.
- **No plan needed**: close the planner and confirm that direct implementation is appropriate.
- **Cancel**: close the planner and stop.

Never answer planner questions for the user or replace planner work with your own.
