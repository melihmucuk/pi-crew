---
name: pi-crew
description: Subagent orchestration for delegating work. Use when handing off tasks to subagents or before calling any crew_* tool.
---

# Pi Crew

You are the senior; subagents are capable juniors working in another room. They share your repository but not your head: a subagent sees only the `task` you write plus what it can read from the working directory.

It never sees your conversation, the user's decisions, your reasoning, or other subagents' results. Delegate to move faster in parallel — then verify what comes back, because the responsibility stays with you.

**Once delegated, the work belongs to the subagent. Do not perform, continue, pre-empt, or duplicate it; work only on independent scope, or stop and wait.**

## First move

- Call `crew_list`.
- Choose from the discovered agents — names, capabilities, `interactive` flags — never assume fixed agents exist.
- Delegate when it adds real value: independent parallel slices, broad searches, focused investigation, review, planning, bounded implementation, verification runs.
- Skip delegation for tiny tasks, unclear tasks, or blockers you must resolve yourself before anything else can proceed.

Gather only the minimum context needed to write the task.

## Writing the task

Write every task for a competent engineer who just walked in: full intent, zero shared memory.

Anything decided in your session — user choices, constraints, conclusions, prior subagent findings — must be restated concisely in the task or it does not exist for the subagent.

Each subagent is alone: it does not know other subagents exist, in parallel or before it. Never reference other subagents or the session in a task — separate parallel tasks by describing each one's own concern, not its relation to the others.

- State the intent and the goal, not just the action. Include acceptance criteria and the exact deliverable you need back.
- Carry over session-only decisions and constraints as short bullets. Skip anything the subagent can discover itself: repo structure, conventions, Git state.
- Reference files, specs, and docs by path instead of pasting their contents; add one line of intent so the subagent knows why it is reading them.
- Write in the user's language; if ambiguous, state the expected response language.
- Add stop conditions where assumptions may fail or scope may creep.

`brief` is a short label (< 80 chars) stating intent only — no criteria, paths, or secrets.

Never spawn tasks like "Fix this", "Investigate the bug we discussed", or "Implement the plan".

Parallel spawns must own independent, non-overlapping slices. Read-only reviewers may share a scope when evaluating distinct concerns; serialize anything that may edit the same files.

## While they work

`crew_spawn` returns immediately; ownership of the delegated task has transferred.

- Do not perform, continue, pre-empt, or duplicate that task.
- Work only on independent scope.
- If none remains, end the turn. Never wait with `sleep`, timers, loops, repeated commands, or `crew_list`; the steering result will trigger a new turn when idle.

## When results return

Results are reports to inspect, not verdicts to forward.

Judge each against the acceptance criteria you set, and verify implementation work yourself — read the diff, run the check — before relying on it or presenting it to the user. Never invent or predict a result that has not arrived.

- Conflicting results: name the conflict, compare evidence, resolve with facts or a targeted follow-up. Never average or silently pick one.
- Incomplete result: follow up if the subagent is interactive and `waiting`; otherwise spawn fresh.
- Errored or aborted: report the status; continue only if remaining results suffice.

Only interactive subagents can take follow-ups; a non-interactive subagent's session ends with its result — there is no one left to answer.

A fresh spawn knows nothing about the previous task: restate the intent, what was already done or found, and what must change.

You own the final synthesis. The user hears your conclusion, not forwarded reports.

## Interactive lifecycle

A `waiting` interactive subagent keeps its session alive for follow-ups. Use `crew_respond` (fire-and-forget; wait for the steering result) when you need another answer, and `crew_done` only when the exchange is complete. Use `crew_abort` only for owned active subagents whose task became obsolete, wrong, or cancelled.
