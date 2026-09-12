# Create a Custom Agent

Resolve every relative link in this document against the directory containing this reference file, not the skill directory or current working directory. Use the resulting absolute paths in tool calls.

Use this workflow when the user wants a custom pi-crew agent. Take the role, intended use, and any target path from their request. If the job is unclear, ask what recurring work the agent should own before drafting.

Write a reusable role, not a one-off task or a generic assistant persona. The owner must know when to select it, and the child must know how to work and when to stop.

## Shape the Role

Gather only decisions that change behavior:

- What work belongs to this agent, and what deliverable should it return?
- When should the owner choose it instead of a nearby role?
- What does it do first, what evidence guides its next step, and what ends the work?
- Can it modify files or cause external side effects? What requires owner approval?
- Which tools and skills does the work actually require?
- Is it project-specific or available across projects?

Inspect relevant existing definitions and project instructions before asking questions the files can answer. Read any skill the new agent will rely on; its workflow and tool requirements must fit the proposed role. Do not copy an existing agent's model, permissions, or output sections just because it is a convenient template.

If a role or permission decision is missing, propose a concrete choice and ask. Do not quietly widen the role or grant capabilities to cover uncertainty.

## Choose the Location

Read [Configuration](../../../docs/configuration.md) for discovery paths, trust rules, supported fields, and overrides.

Use the user's named path when given. Otherwise settle project versus global placement before writing:

- Project: Pi's project agents directory, normally `<cwd>/.pi/agents/`.
- Global: Pi's user agents directory, normally `~/.pi/agent/agents/`.

Use `<name>.md` as the filename. Check for an existing definition with the same name and relevant `pi-crew.json` overrides: project definitions shadow user definitions, which shadow bundled definitions. Do not overwrite an existing agent or introduce a shadowing definition without the user's intent being clear. Project resources require project trust.

## Write the Frontmatter

Use only the supported agent fields. The [field reference](../../../docs/configuration.md#frontmatter-fields) owns accepted values and defaults; the guidance here explains how to choose them.

- `name` and `description` are required. Prefer a short lowercase, hyphenated name that describes the role and also works with `@crew:name`.
- `model`: omit to inherit the owner's model unless the user chose a specific one. A configured `provider/model-id` must be available exactly; do not invent an ID or silently substitute another model.
- `thinking`: set only when there is a role-specific or user-requested reason; use a supported value.
- `tools`: choose the tools needed for the work. Omission grants all built-ins, not zero tools. Use an explicit list for a restricted role; `[]` means no task tools. Custom tools require their registering extension in the child session. A `+`/`-` list modifies the built-in set in a definition; use a plain list when you mean an allowlist.
- `skills`: list the verified skills the role depends on. Omission exposes all discovered skills; `[]` exposes none. Selecting a skill does not supply missing tools or force the agent to read it—put required read triggers in the body.
- `compaction`: omit for the default `true` unless the task has an explicit reason to disable it.

pi-crew supplies `crew_report` independently of the task-tool list, and every successful agent supports follow-up turns. Do not copy skill frontmatter fields into an agent definition or add unsupported fields such as `interactive`.

## Make the Description a Selection Rule

The owner sees the description in `crew_list`, not the full body or tool/skill lists. Write one or two sentences stating:

1. What the agent does and returns.
2. When to choose it, including a distinguishing boundary or essential input when useful.

Good:

> Maps API routes and authentication checks without changing files. Use when you need an evidence-backed endpoint inventory before planning an authorization change.

Weak:

> An expert API agent that helps with backend tasks.

Do not make the description a tool inventory, a personality, or a promise the body cannot fulfill. A read-only description needs corresponding instructions; a tool list alone does not enforce read-only behavior because `bash` can write too.

## Give the Body a Working Rhythm

Write English instructions that define the stable role. Keep specific URLs, current user choices, approved scope, and today's steps in the spawned task rather than baking them into the definition.

A useful body covers these in a natural order; use headings only when they help:

- **Role and outcome:** one opening sentence explaining the job and the evidence or artifact it returns. Reply in the task's language.
- **Assignment:** use Goal to judge completion. Honor user decisions and approved scope in Context; follow actions and execution constraints in Instructions. Verify prior findings when the work depends on them.
- **First move and rhythm:** what to inspect or load first, how to choose the next action, and how to verify its result. Reference required skills by name with an explicit read trigger instead of copying their manuals.
- **Boundaries:** permitted changes, disallowed side effects, and approval requirements specific to the role. Keep restrictions consistent with its tools, skills, and project instructions.
- **Stopping:** stop when the Goal is met. If instructions conflict, a decision is missing, or the role cannot finish safely, report the blocker and the exact owner input needed rather than guessing.
- **Output:** ask for the evidence the owner needs to verify this role's work—paths, observed behavior, citations, checks, or saved artifacts. Separate verified results from assumptions and skipped checks. Do not impose sections that add nothing for this role.

The body defines the content of the report, not a competing result protocol. pi-crew's injected `crew_report` tool handles `completed` and `needs_input`; do not demand a second final answer after the report. For follow-ups, retain the same deliverable and incorporate new owner information; do not silently absorb a different scope. Do not instruct the child to spawn other agents or manage owner-side cleanup.

See [Result protocol](../../../docs/result-protocol.md) when writing output or blocker instructions. Do not duplicate its schema, reminder mechanics, or delivery policy in the agent body.

## Review, Save, and Check

Before saving, show the proposed path and complete definition. Briefly explain its role, permissions, and any non-default model or skill choices. Resolve missing decisions and get approval for the definition; if the user already supplied an exact approved definition and path, write that rather than reopening settled choices.

After approval, write only the agreed definition. Check the frontmatter against the supported fields and inspect the body for conflicts with the description, selected skills, and task contract. Check that named skills and custom tools are available rather than treating their names as proof.

Use `crew_list` for a discovery snapshot to confirm the intended agent is visible and check warnings. Because it omits tools and skills, inspect the definition and applicable overrides to verify those settings. Discovery does not prove the agent behaves correctly. Do not spawn a trial task unless the user approved one; if approved, use a bounded task with an observable outcome and follow the parent skill's verification and cleanup rules.

Finish with the saved path, what was checked, and any behavior that remains untested. Stop; do not create extra agents, skills, config files, or sample outputs.
