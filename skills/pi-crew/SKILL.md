---
name: pi-crew
description: Delegate work to subagents or create custom pi-crew agents. Use when handing off tasks, before calling any crew_* tool, or when writing a custom agent definition.
---

# Pi Crew

Delegate bounded work to subagents; responsibility for scope, verification, and the final answer stays with you.

## Choose the Workflow

- To create a custom agent, read [Create a Custom Agent](references/create-agent.md) and follow it for role design, frontmatter, body instructions, and verification. Resolve the path relative to this skill directory. Creating a definition does not require spawning it.
- To delegate work to an existing agent, follow the orchestration workflow below.

## Select

Call `crew_list` and select each resolved agent by its role description. Every subagent supports follow-up turns.

An inline `<pi-crew subagent="name" />` reference records the subagent the user selected with `@crew:name`; mention names use only ASCII letters, digits, and hyphens. It is not an unconditional instruction to spawn. Use the surrounding sentence's intent to decide whether delegation is requested.

Use multiple subagents whenever the work has independent parts: separate scopes, distinct deliverables, or complementary review angles. Give every spawn a separate goal and avoid duplicate ownership.

Do not build generic handoff pipelines merely because several roles are available. A subagent should perform its own bounded investigation unless separate discovery, decision analysis, or planning is independently valuable to the user's request.

Do not use an agent whose stated purpose does not match the requested deliverable.

## Delegate

- Delegate for useful independent work such as broad discovery, focused planning or review, bounded implementation, and verification. Skip tiny tasks where delegation adds no value; resolve unclear scope or blocking decisions first.
- Gather only enough context to write the assignment; leave delegated investigation to the subagent.
- Read-only reviewers may inspect the same scope for distinct concerns; serialize work that may edit the same files.

## Size and split

One task is one deliverable the subagent can finish and verify on its own, and that you can check in a single pass. Judge size by scope and difficulty, not by item count: a hard five-step task may need splitting, a simple twelve-step task may not.

- Split when parts have different deliverables or different verification, or when you would need several follow-up rounds to steer one agent through them.
- Run parts in parallel when they touch disjoint files and neither needs the other's result.
- Run parts in sequence when one depends on another's outcome. Write the next task after the result arrives and carry the confirmed findings into its context; do not pre-write it on assumptions.
- Keep parts together when they edit the same files or one change is meaningless without the other.
- Signs a task is too big: the goal joins unrelated outcomes with "and"; instructions mix discovery, implementation, documentation, and verification of separate things; you expect to correct course mid-way.

## Two modes

Decide first whether you are starting a subagent or continuing one; the message you write is different in each case.

- `crew_spawn`: the subagent starts empty. It sees only the task, the repository, and its own definition. Write a complete ticket for someone who joined today.
- `crew_respond`: the subagent remembers its own task, findings, and last answer. Do not restate them. Write only what it could not see since its last turn: a user decision, files you or another agent changed, a rejection or correction, and what it must not touch now. Name those items; do not point at "the changes above" or anything else from your own conversation.
- Same deliverable, needs correction → `crew_respond` while the agent is `completed` or `needs_input`. New scope or a different deliverable → `crew_spawn` with a new task.
- If new information arrives while the subagent is running, keep it until the result arrives, then send it with `crew_respond` if still relevant. Do not poll for completion.

## Write the assignment

Write the `crew_spawn` task like a ticket for a contractor who joined today.

- `goal`: one or two sentences describing the finished state and how to tell it is reached. No steps, no background.
- `context`: only what the subagent cannot find in the repository: user decisions, approved scope, prior findings with their source and confidence. User decisions and approved scope are binding, not optional background. Put actions and execution constraints in `instructions`.
- `instructions`: one action or one constraint per item. Keep actions and prohibitions in separate items and make prohibitions unambiguous ("Do not run X", not "X running"). End with a stop condition: what to do when instructions conflict with what the repository actually does, or when a decision is needed.
- Reference files, specs, and docs by path and say why each one matters; do not paste them.
- Never delegate a decision. "Create a file if needed" or "extend scope if useful" is a decision; make it yourself first or write "stop and ask if X".
- Verify any repository fact before turning it into a constraint. If you cannot verify it, write "if X, stop and report" instead of "do not X".
- When a task follows up on earlier findings or a previous task's result, list each item in context with its location, the problem, and what was changed for it. A subagent cannot verify a fix it has not been told about; summarizing fixes by category is not enough. If you cannot list them, do not mention them.
- A safety rule that you find yourself repeating across tasks belongs in the project's AGENTS.md, not in every task. Propose it to the user.
- Write task values in the user's language. Do not repeat generic rules owned by the subagent definition.
- Never delegate a vague assignment such as "Fix this", "Investigate what we discussed", or "Implement the plan" without the missing specifics.

**Once a task is spawned, do not continue, pre-empt, or duplicate that work. Work only on independent scope; if none remains, end the turn and let the result arrive without polling.**

## Integrate

- Make integration decisions from the exact result `outcome`, not from wording in the report. `report` is the subagent's complete role-specific final answer; do not wait for or ask for a second summary.
- Every delivered result wakes you with a new turn, even while other subagents are still running. Act on what arrived — verify it, respond, or close it — then end the turn if no independent work remains.
- When several results feed one next step, hold that step until every spawned agent in the batch has settled: keep each accepted result as it arrives, but do not synthesize, delegate the next stage, or write the final report until the batch is complete.
- For `completed`, verify the report against the assignment before relying on it. Use `crew_respond` for correction or follow-up on the same deliverable.
- For `needs_input`, read `needs` as the exact requested intervention. If you know it, send it with `crew_respond`; otherwise ask the user for that intervention, then respond with their answer.
- Use only results that have actually arrived; never invent or predict a pending result.
- Resolve conflicting results from evidence or a targeted follow-up; do not average or silently choose.
- A follow-up via `crew_respond` follows the two-modes rule: short items, one action each, ending with when to stop; never a single paragraph.
- Every successful cycle remains open as `completed` or `needs_input`. You own successful-session cleanup: after a `completed` result is verified and no follow-up remains, close it with `crew_done`. Do not add timeouts or automatic cleanup. Abort work only when it has become obsolete, incorrect, or cancelled.
- Continue after an error or abort only when the remaining evidence is sufficient.
- Synthesize the final answer yourself.
