---
name: pi-crew
description: "MUST read before crew tools. Delegate bounded work to async subagents; you own scope, vetting, and synthesis."
---

# Pi Crew

Use this skill to coordinate subagents safely. Core rule: delegate clearly with self-contained tasks, let delegated work run without redoing it, and manage the async/interactive lifecycle explicitly.

## Your Responsibilities

Keep these responsibilities local:

- Decide whether delegation is worth it.
- Split work into independent, non-overlapping slices.
- Define scope, stop conditions, and acceptance criteria.
- Vet returned evidence before relying on it.
- Resolve conflicting results.
- Integrate outcomes and own the final user-facing synthesis.

## Context Boundary

A subagent runs isolated from your session but inside the same repository:

- It sees only the `task` you write plus what it can read from the working directory. Every subagent can read repo files, config, and persistent docs to gather context on its own; whether it can also edit files or run commands depends on the chosen subagent's tools (see `crew_list`).
- It cannot see your session conversation, your reasoning, user decisions, or prior subagent results unless they are written to a durable file. Put any such context the subagent needs directly in the task.
- Do not dump context the subagent can find itself (repo structure, conventions, Git state, changed-file lists). Do include session-only intent, decisions, and conclusions it cannot discover.
- State the exact output you need (deliverable, format, acceptance criteria) so the subagent works toward it and returns something you can act on.

Write every task so a subagent that knows nothing about this session can complete it and return the output you need.

## Protocol

- Call `crew_list` before each new spawn decision. Choose from discovered names, descriptions, capabilities, and `interactive` flags; do not assume fixed agents exist.
- Spawn only when delegation adds clear value: independent parallel work, broad repo search, focused investigation, review, planning, bounded implementation, verification runs, browser/test passes, or log reduction.
- Do not spawn for tiny tasks, unclear tasks, immediate blockers you must resolve before proceeding, or work whose required context cannot be summarized safely.
- Before spawning, gather only the minimum context needed to write the task; do not start the investigation, review, plan, or implementation you intend to delegate.
- Parallel spawns must be independent and non-overlapping. If multiple subagents may touch the same files or ownership area, serialize them.

## Spawn Brief

Every `crew_spawn` needs:

- `brief`: short human-readable label for session lists, ideally under 80 chars. State intent/outcome only; no full task, criteria, long paths, secrets, or repo inventory.
- `task`: self-contained work request with only the context this subagent needs.

Include task-specific details only when useful:

```md
Intent / context:
Relevant inputs / entry points:
Constraints / decisions:
Deliverable / expected outcome:
Verification / checks:
Stop conditions:
```

Omit sections that add no task-specific value. Do not restate the subagent’s role, default scope, edit permissions, output format, obvious next steps, cwd/branch, Git status, or full changed-file lists unless they define the scope.

Prefer short Markdown bullets for multi-part context, constraints, requirements, or acceptance criteria. Use stop conditions for assumptions that may fail, scope that may expand, repeated verification failures, or missing evidence.

For repeated workflows, summarize the relevant facts or point to durable artifacts the subagent can read; avoid vague references like “the previous fixes.”

If the user points to a plan, spec, issue, design, or doc, read it when practical and summarize the relevant intent instead of only passing the path.

### Examples

Good `task` (intent-first and self-contained):

```md
Intent / context:
Password reset emails should expire after 30 minutes, but old reset links still work hours later.

Relevant inputs / entry points:
- Password reset request handler.
- Token validation path used by the reset form.
- Config or DB fields storing token expiry.

Constraints / decisions:
- Keep the existing email template and reset URL format.
- Do not change login or account creation.

Deliverable:
Likely root cause and the smallest safe fix direction.
```

Avoid tasks like `Fix this.`, `Investigate the bug we discussed.`, or `Implement the plan.`: they depend on session-only context the subagent cannot see.

## After Spawning

`crew_spawn` is non-blocking: it returns immediately without the result, the subagent runs in the background, and its result is delivered separately as a steering message. Ownership of the task transfers to the subagent.

Once you spawn:

- Do not perform, redo, continue, or pre-empt the delegated task in this turn, even partially, and even if you believe you could finish it faster yourself.
- Do only work that is independent of and non-overlapping with what you delegated.
- If you have no such independent work, end your turn and wait for the result. Do not poll; call `crew_list` again only for a new spawn decision or a requested status snapshot.

## Result Handling

- Wait for subagent results before using them. Never invent or predict results.
- Treat subagent results as evidence to inspect, not verdicts to forward.
- Evaluate each result against the task acceptance criteria.
- If a subagent errors or aborts, report that status and continue only if the remaining results are sufficient.
- If results conflict, do not average or silently pick one; state the conflict, compare evidence, and resolve with available facts or a targeted follow-up. If a result is incomplete or misses criteria, use a focused follow-up or new spawn only when needed.

## Interactive Subagents

- Use `crew_respond` only for a waiting interactive subagent when another answer is needed.
- `crew_respond` is fire-and-forget; wait for the next steering result and do not poll.
- Use `crew_done` only when a waiting interactive subagent is complete.
- Do not call `crew_done` if you still need another answer.

## Abort

Use `crew_abort` only for active subagents owned by this session when the task is obsolete, wrong, or cancelled.
