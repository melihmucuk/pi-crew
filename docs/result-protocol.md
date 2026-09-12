# Result Protocol

## Successful Results

Every successful prompt cycle ends with a `crew_report` result:

```ts
{
  outcome: "completed";
  report: string;
}
{
  outcome: "needs_input";
  report: string;
  needs: string;
}
```

`report` is non-blank and contains the subagent's complete role-specific final answer; no second summary follows. `needs` is required and non-blank only for `needs_input`, and is forbidden for `completed`. Unknown fields are rejected.

The final tool-call batch must contain only one successful `crew_report` call. Task tools may be used in earlier batches. Acceptance is judged from the cycle's last assistant message and the corresponding tool result.

If a normal cycle ends without a valid final report, pi-crew sends one finalization follow-up prompt automatically, visible in the child session. A second reportless normal ending becomes a terminal contract error. Technical `error` and `aborted` endings receive no reminder.

Validation is cycle-local: every `crew_spawn` and `crew_respond` starts fresh. A report from an earlier cycle cannot satisfy a later one.

## Lifecycle

- `running`: the subagent is working and cannot receive follow-up messages.
- `completed`: verify the report, request corrections if needed, then close it.
- `needs_input`: answer the requested intervention through `crew_respond`.
- `error` or `aborted`: terminal; the child session is disposed.

Both successful outcomes remain visible and abortable until explicitly closed with `crew_done`. Follow-ups retain the child's own conversation; send only new information, not a restated task. Use a new spawn for a different deliverable.

`crew_spawn` and `crew_respond` return without waiting for the prompt cycle. A follow-up starts a new cycle, moving the subagent back to `running`.

## Owner Delivery

Delivered model context is JSON, separate from TUI presentation. Successful deliveries preserve the validated result exactly:

```json
{
  "subagent_id": "worker-123",
  "brief": "task label",
  "result": {
    "outcome": "needs_input",
    "report": "The implementation needs a product decision before proceeding.",
    "needs": "Should expired invitations be deleted or retained?"
  }
}
```

Error deliveries use the same identity fields with `status` and `error`, never a fabricated successful result. Aborts are TUI-only entries, not model context: the owner already knows from `crew_abort` or is shutting down.

Every delivered `completed`, `needs_input`, or `error` result uses `{ deliverAs: "steer", triggerTurn: true }`:

| Owner state | Delivery                                                                        |
| ----------- | ------------------------------------------------------------------------------- |
| Idle        | Delivered immediately and triggers a turn                                       |
| Streaming   | Queued as steer into the running turn                                           |
| Inactive    | Queued; pending messages older than 24 hours are dropped when the owner returns |

Results are not held back while peers are still running. When several results feed one next step, orchestration must wait for the whole batch before synthesis or the next stage. See the [skill](../skills/pi-crew/SKILL.md#integrate) and the workflow's own acceptance rules.

On `/new`, `/resume`, and `/reload`, background work is preserved and delivery reconnects when its owner becomes active. A runtime-version change during reload aborts the stale runtime's subagents before replacing it. On `/fork` and `/clone`, active subagents—including those awaiting an owner action—and their queued results move to the new session. Quitting Pi aborts active subagents.

## TUI Presentation

Results appear as Markdown cards rather than protocol JSON. Each card starts with the outcome icon, subagent ID, and task label, followed by the unchanged report. Needs-input cards put a **Needs** section before the report; error cards show their explanation.

Cards are rendered from structured result details, not copied display text in model context. Aborts render as compact TUI-only cards with the reason and never trigger an owner turn. See [Results and Sessions](../README.md#results-and-sessions) for everyday TUI usage.
