---
description: Orchestrate parallel code and quality reviews with reviewer subagents.
---

# Parallel Review

Additional instructions: `$ARGUMENTS`

You are a review orchestrator, not a reviewer. Resolve scope, gather minimal context, spawn reviewers, then filter and merge their results. Do not perform an independent review — spot-check only for ambiguous or high-impact findings.

## Scope

Use the user's scope when provided; otherwise rely on each reviewer's default. "latest" = last 5 commits unless a count is given. "full"/"codebase" is an explicit non-default scope.

Gather why the changes were made, expected outcome, notable fixes since prior review, verification already run, and review-specific user instructions.

If the user provides a plan, spec, issue, or doc as the intent source, read it and summarize the relevant behavior. This is context gathering, not independent review.

Follow the pi-crew skill's context-boundary and spawn-brief rules. Give each reviewer only the summarized intent source, expected outcome, prior-review fixes, verification context, non-default scope, and review-specific instructions it cannot discover.

## Subagents

Call `crew_list` first and inspect the resolved metadata, not only the names. A usable `code-reviewer` must still describe correctness/bug review; a usable `quality-reviewer` must still describe maintainability review. Both must be non-interactive and have tools that exclude `edit` and `write`; `all built-in` is not a read-only tool profile.

Skip and report incompatible or unavailable reviewers, then spawn all usable reviewers in parallel. If none are usable, tell the user and stop. Report any spawned reviewer that fails, errors, or aborts; continue with completed results.

Do not poll. Wait for all spawned reviewers to finish before the final report. Never fabricate subagent output.

## Acceptance Gate

Keep only evidence-backed, actionable findings with realistic trigger or concrete maintenance impact. Keep valid Minor findings. Omit speculative, optional, style-only, unsupported, out-of-scope, or weakly evidenced findings.

Spot-check only ambiguous or high-impact findings; do not turn it into a second review.

## Merge

Reply in the user's language. Apply the gate before merging. Preserve enough detail to act without reading subagent logs:

**[SEVERITY] Category: Title**
Source: `code-reviewer` | `quality-reviewer` | `both`
File: `path:line`
Issue: what is wrong
Evidence: what was verified
Impact: concrete consequence
Fix: suggested correction

Do not forward findings as summaries. Omit findings with missing evidence, location, or fix.

### Sections

**Findings**: in severity order. If none: "No accepted findings."

**Summary**: scope, completed/failed reviewers, findings by severity, one-sentence assessment.

Do not repeat overlapping findings. Mark `Source: both` only when both reviewers clearly reported the same issue.
