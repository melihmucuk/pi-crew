---
description: Run parallel code and quality reviews by gathering minimal context and orchestrating reviewer subagents.
---

# Parallel Review

## Input

**Additional instructions**: `$ARGUMENTS`

## Role

This is an orchestration prompt.
Determine review scope with minimal context gathering, prepare a short neutral brief, spawn the reviewer subagents, wait for their results, and merge them into one final report.

Do not perform the review yourself.
Do not perform a broad second review or re-investigate the whole repository. Your job is orchestration, filtering, and merging. If a reviewer finding is ambiguous, high-impact, or appears out of scope, you may do a minimal spot-check to clarify whether it is concrete enough to include.

## Scope Rules

- If the user specifies a scope (commit, branch, files, PR, or focus area), that scope overrides the default scope.
- Otherwise, default scope includes:
  - recent commits
  - staged changes
  - unstaged changes
  - untracked files

## Context Gathering

Collect only enough context to define scope and prepare a short brief.

Collect:

- repo root
- current branch
- `git status --short`
- `git log --oneline --decorate -n 5`
- `git diff --stat --cached`
- `git diff --stat`
- untracked file list

For recent commits:

- use `HEAD~3..HEAD` if at least 3 commits exist
- otherwise use the widest reachable history range

Collect for that range:

- `git diff --stat <range>`
- `git diff --name-only <range>`

Rules:

- Do not read full files before spawning subagents.
- Do not dump raw diffs into the prompt.
- Do not inspect every changed file manually.
- Use full diffs or targeted reads only when file names and diff stats are insufficient to produce a short neutral summary.
- Keep the brief short and descriptive, not analytical.
- Watch for diminishing returns: if you have enough to define scope and write the brief, stop gathering context. More git commands or file reads at this stage add noise, not clarity.

## Subagent Preparation

Call `crew_list` first and verify that both are available:

- `code-reviewer`
- `quality-reviewer`

Prepare one short brief for both reviewers including:

- repo root
- resolved review scope
- commit range if any
- staged / unstaged / untracked status
- changed files
- short summary per file or file group
- additional user instructions
- **explicit scope boundary**: what is being reviewed (in scope) and what is not being reviewed (out of scope). For example: "Only the auth module changes are in scope. The unrelated CSS refactor in the same PR is out of scope for this review."

## Execution

Spawn `code-reviewer` and `quality-reviewer` in parallel.

If one reviewer is unavailable or fails to start, report that clearly and continue with the reviewer that is available.

Do not produce a final report until all successfully spawned reviewers have returned a result.
Do not poll or repeatedly check active subagents while waiting; results will be delivered asynchronously.

## Findings Acceptance Gate

Before including a reviewer finding in the final report, apply these filters:

Include a finding only if:
- it is actionable now
- it describes a realistic scenario for this project
- it includes a concrete trigger or maintenance impact
- it includes evidence or a clear rationale from the reviewer
- its severity matches the described likelihood and impact

Exclude findings that are:
- speculative or theory-driven (no realistic trigger)
- based on broken invariants or unsupported usage
- style preferences or optional refactors without concrete bug risk
- vague suggestions without concrete trigger, impact, or evidence

Do not exclude a legitimate Minor finding that has a concrete trigger and realistic near-term impact. Minor findings with evidence pass the gate; Minor findings without evidence do not.

If a finding clearly fails the gate, omit it rather than forwarding reviewer noise to the user. Prefer omission for weak or optional findings, but do not discard a potentially important finding solely because the reviewer wrote it imperfectly. The merged report should be shorter and more impactful than the raw reviewer outputs, not a concatenation of them.

## Merge

Write the final response in the same language as the user's request.

Structure:

### Consensus Findings

Merge only findings that are clearly the same issue reported by both reviewers.

### Code Review Findings

Include findings reported only by `code-reviewer`.

### Quality Review Findings

Include findings reported only by `quality-reviewer`.

### Final Summary

Include:

- review scope
- which reviewers ran
- consensus findings count
- code review findings count
- quality review findings count
- overall assessment

Rules:

- Do not repeat overlapping findings.
- Do not invent reviewer output, evidence, or counts.
- Do not present a single-reviewer finding as consensus.
- Apply the Findings Acceptance Gate before merging. Do not forward weak, speculative, or optional findings; if a single-reviewer finding appears important but ambiguous, do a minimal spot-check before deciding.
- If both reviewers report no issues, say so explicitly.
- If one reviewer failed or was unavailable, say so explicitly.
- Review only. Do not make code changes.
- Do not perform independent review beyond minimal scope and validity checks on reviewer findings. Only orchestrate reviewers and merge their reported results.
- Never fabricate subagent results. Wait for all successfully spawned reviewers to return.
