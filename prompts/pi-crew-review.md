---
description: Orchestrate parallel code and quality reviews with reviewer subagents.
---

# Parallel Review

Additional instructions: `$ARGUMENTS`

Act as the review orchestrator. Delegate correctness and maintainability review, then verify and merge the results. Do not perform a separate full review or modify files.

Follow the pi-crew skill for delegation and result handling.

## Prepare

Use additional instructions when provided; otherwise review current uncommitted changes. Gather only session facts the reviewers cannot discover: implementation purpose and expected behavior, user decisions and constraints, prior-review fixes, and verification already run.

Reference readable intent sources by path and state why they matter. Do not inspect implementation details before delegation.

Call `crew_list` and select by role description: `code-reviewer` should focus on correctness and `quality-reviewer` on maintainability. Skip a reviewer whose description points elsewhere or that is unavailable; stop if neither is usable.

## Delegate

Spawn all usable reviewers in parallel. For each task:

- Set a role-specific Goal requiring evidence-backed findings or confirmation that no issue was found.
- Put implementation intent, expected behavior, user decisions, approved review scope, prior fixes, and verification context in Context.
- Use Instructions for review actions, referenced intent sources and their purpose, execution constraints, additional user focus, and task-specific stop conditions.

Do not repeat review criteria already owned by the selected reviewer.

For a re-review after fixes, list each prior finding in Context as its own item: location, issue, and the change made for it (file, test). Name the files changed since the previous review. A reviewer cannot verify a fix it has not been told about; if you cannot list the findings, request a fresh full review and do not mention prior findings.

## Acceptance Gate

Do not accept or reject any finding, or write the final report, until every spawned reviewer has settled. Handle each reviewer by exact outcome as it arrives. For `needs_input`, satisfy `needs` with `crew_respond` when you know the answer; otherwise ask the user for that exact intervention and relay it. Any reviewer may return this outcome. For `completed`, treat `report` as the full review and do not wait for another summary.

Check each reported finding before accepting it, inspecting only the evidence needed rather than performing another full review.

Keep findings only when they are in scope, evidence-backed, actionable, and have a realistic correctness trigger or concrete maintenance cost. Keep valid Minor findings. Correct or discard unsupported claims with evidence; remove speculation, style-only feedback, weak findings, and duplicates.

Preserve verified Human Reviewer Callouts separately. Callouts are informational, do not affect severity, and must not become findings unless an independent defect also passes the gate. Deduplicate overlapping callouts and keep the most specific label.

For full or codebase reviews, preserve each reviewer's directly inspected and skipped coverage for the final summary.

If a completed review needs correction, use `crew_respond` before accepting it. Explicitly close each accepted completed reviewer session with `crew_done`. Report failed, errored, or aborted reviewers without inventing their output. Continue when the completed evidence is sufficient.

## Output

Reply in the user's language. Report accepted findings in severity order:

**[SEVERITY] Category: Title**
Source: `code-reviewer` | `quality-reviewer` | `both`
File: `path:line`
Issue: what is wrong
Evidence: what was verified
Impact: concrete consequence
Fix: suggested correction

Use these sections:

- `## Findings`: accepted findings, or **No accepted findings.**
- `## Human Reviewer Callouts (Non-Blocking)`: only when applicable.
- `## Summary`: scope, completed or failed reviewers, finding counts by severity, full-review coverage when applicable, and a one-sentence assessment.

Use `Source: both` only when both reviewers independently reported the same issue. Do not forward or summarize rejected findings.
