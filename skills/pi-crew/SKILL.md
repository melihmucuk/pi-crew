---
name: pi-crew
description: Subagent orchestration for delegating work. Use when handing off tasks to subagents or before calling any crew_* tool.
---

# Pi Crew

Delegate bounded work to subagents; responsibility for scope, verification, and the final answer stays with you.

Subagents share the repository, not the owner's conversation. They do not know the user's decisions or prior subagent results unless you include them in the task.

## Select

Call `crew_list` and treat each resolved agent's description and capabilities as the source of truth for its role.

Use multiple subagents when each contributes an independent scope, distinct deliverable, or genuinely complementary perspective. Give every spawn a separate goal and avoid duplicate ownership.

Do not build generic handoff pipelines merely because several roles are available. A subagent should perform its own bounded investigation unless separate discovery, decision analysis, or planning is independently valuable to the user's request.

Do not use an agent whose stated purpose does not match the requested deliverable.

## Delegate

- Delegate for useful independent work such as broad discovery, focused planning or review, bounded implementation, and verification. Skip tiny tasks where delegation adds no value; resolve unclear scope or blocking decisions first.
- Gather only enough context to write the assignment; leave delegated investigation to the subagent.
- Read-only reviewers may inspect the same scope for distinct concerns; serialize work that may edit the same files.

## Write the assignment

- Make every assignment self-contained. Restate relevant user decisions and prior findings; never refer to "above", "earlier", or another agent without including the information needed.
- Reference readable files, specs, and docs by path instead of pasting them, and state why each reference matters.
- Include task-specific completion criteria, requested artifacts, and stop conditions when needed; do not repeat generic rules owned by the subagent definition.
- Write task values in the user's language.
- Never delegate a vague assignment such as "Fix this", "Investigate what we discussed", or "Implement the plan" without the missing specifics.

**Once a task is spawned, do not continue, pre-empt, or duplicate that work. Work only on independent scope; if none remains, end the turn and let the result arrive without polling.**

## Integrate

- Treat results as reports to evaluate against the assignment's goal and instructions, not answers to forward. Check each result before relying on it.
- Use only results that have actually arrived; never invent or predict a pending result.
- Resolve conflicting results from evidence or a targeted follow-up; do not average or silently choose.
- For an incomplete result, follow up when the agent is `waiting`; otherwise delegate a new self-contained task.
- Close a waiting agent when the exchange is complete. Abort work only when it has become obsolete, incorrect, or cancelled.
- Continue after an error or abort only when the remaining evidence is sufficient.
- Synthesize the final answer yourself.
