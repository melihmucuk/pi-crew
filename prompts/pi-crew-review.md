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

Call `crew_list` and use only compatible definitions: `code-reviewer` must be a non-interactive, read-only correctness reviewer; `quality-reviewer` must be a non-interactive, read-only maintainability reviewer. Treat `all built-in` as non-read-only. Skip incompatible or unavailable reviewers; stop if neither is usable.

## Delegate

Spawn all usable reviewers in parallel. For each task:

- Set a role-specific Goal requiring evidence-backed findings or confirmation that no issue was found.
- Put implementation intent, expected behavior, user decisions, prior fixes, and verification context in Context.
- Use Instructions for the review scope, referenced intent sources and their purpose, additional user focus, and task-specific stop conditions.

Do not repeat review criteria already owned by the selected reviewer.

## Acceptance Gate

Check each reported finding before accepting it, inspecting only the evidence needed rather than performing another full review.

Keep findings only when they are in scope, evidence-backed, actionable, and have a realistic correctness trigger or concrete maintenance cost. Keep valid Minor findings. Correct or discard unsupported claims with evidence; remove speculation, style-only feedback, weak findings, and duplicates.

Preserve verified Human Reviewer Callouts separately. Callouts are informational, do not affect severity, and must not become findings unless an independent defect also passes the gate. Deduplicate overlapping callouts and keep the most specific label.

For full or codebase reviews, preserve each reviewer's directly inspected and skipped coverage for the final summary.

Report failed, errored, or aborted reviewers without inventing their output. Continue when the completed evidence is sufficient.

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
