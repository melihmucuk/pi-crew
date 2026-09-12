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

Call `crew_list` and select by role description: `scout` must fit read-only discovery, and `planner` must fit read-only implementation planning. Continue without a scout; stop if no compatible planner exists.

## Scout

When repository discovery would improve the plan, spawn up to 4 scouts with independent focus areas.

For each scout task:

- Set a discovery-specific Goal describing the evidence or code map needed.
- Put relevant user decisions, approved scope, and other session-only facts in Context.
- Use Instructions to define the focus area, referenced sources and their purpose, constraints, and any task-specific evidence or stop conditions.

Handle each scout result by exact outcome. For `needs_input`, satisfy `needs` with `crew_respond` when you know the answer; otherwise ask the user for that exact intervention and relay it. For `completed`, treat `report` as the full discovery handoff: check material findings before passing them on, correct or discard unsupported claims with evidence, and preserve conflicts and gaps. Close the scout with `crew_done` after its accepted report has been transferred into planner context.

Spawn the planner only after every spawned scout has settled; keep accepted findings in your context until then, even when a scout reports early.

Retry a failed or unusable scout task at most once. Preserve any remaining gap for the planner.

## Planner

Spawn the planner with:

- A Goal requiring the smallest deterministic, implementation-ready plan for the requested outcome.
- Context containing user decisions, approved scope, cleaned scout findings, conflicts, and gaps.
- Instructions containing planning actions, execution constraints, intent-source references with their purpose, and any additional planning requirements.

Let the planner verify findings it materially relies on. Do not rewrite planner output already delivered to the conversation.

## Lifecycle

Use the planner's exact outcome first:

- **`needs_input`**: treat `needs` as the requested intervention. Respond directly when the answer is known; otherwise ask the user for that exact input and relay the complete answer with `crew_respond`. If it materially changes the Goal, close the planner and spawn a new task.
- **`completed`**: treat `report` as the delivered plan or `No plan needed` answer; do not wait for another summary. Verify it before presenting it. If the same deliverable needs correction, use `crew_respond`. When no correction or follow-up remains, close the planner with `crew_done`.
- **Implementation Plan**: ask for approval or feedback when follow-up may still be useful and relay corrections with `crew_respond`; close the planner once the plan is accepted. If implementation is delegated, slice the plan into worker tasks by phase following the skill's size-and-split rules, and copy each phase's steps verbatim into that task's instructions.
- **No plan needed**: close the planner after verification and confirm that direct implementation is appropriate.
- **Cancel**: close the planner and stop.

Never answer planner questions for the user or replace planner work with your own.
