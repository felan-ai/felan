# Agents, tasks, and Prewalk

Felan Code separates three concerns that are often represented by one generic
“agent” feature:

- **subagents** execute independent work asynchronously;
- **tasks** record dependency-aware shared execution state; and
- **Prewalk** routes one useful session from planning into implementation.

They work together, but each remains usable on its own.

## Asynchronous subagents

The `Agent` tool queues a child and returns immediately. The root can continue
working, then list, inspect, steer, continue, or cancel direct children. Felan Code
delivers a completion notice when a child finishes. Cancelling a running child
records and persists the cancellation before returning; session cleanup may
continue in the background, so the acknowledgement does not claim that every
underlying operation stopped instantly.

The portable extension exposes exactly five tools:

- `Agent`
- `list_subagents`
- `get_subagent_result`
- `steer_subagent`
- `cancel_subagent`

The local host owns admission, persistence, nesting, cancellation, model
selection, and completion delivery. `/agents` or `Alt+A` opens live and stored
child transcripts in the TUI. The selected-agent header and agent rows show
each child session's captured USD cost beside its elapsed time. Running costs
refresh after each persisted assistant response, and retained costs reload with
the root session. In the navigator, scroll the selected transcript with the
mouse wheel or trackpad, Page Up/Page Down, or Home/End; the agent list and
steering input remain fixed while the transcript moves.

Delegated prompts should define disjoint scopes and a concise expected output.
Do not repeat exploration from a child-owned scope. If no independent parent
work remains, yield and rely on completion notices rather than polling. Cancel
a child before taking over its unfinished scope. When using the shared task
graph, each session claims only its own ready task; force recovery is reserved
for an explicitly stale claim.

Felan's persistent system prompt describes when a child pays off: broad
discovery across many unknown files on a cheaper model that returns a compact
summary instead of the parent reading them, an independent review or completion
check in a fresh context, or independent tasks with disjoint file scopes that
can run in parallel. Small, sequential, known-location, and critical-path work
stays in the parent. The prompt also rules out re-reading a delegated scope,
delegating trivial lookups, and launching several reviewers when one suffices.
Without a classifier, the main model applies that guidance itself.

When a classifier is configured (`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`),
root sessions ask it one question per user turn: does this request need broad
discovery that the conversation does not already cover? At a probability of
0.65 or higher, a routing section directs the model to delegate that discovery
to `explore` children and wait for their summaries instead of reading the same
scope. Small repositories and one-shot print/JSON modes skip discovery
classification because it would add overhead or return before a child finished.
Otherwise, and when classification fails, no section is added. The
classifier also chooses the model tier for each `Agent` call whose definition
does not pin a model. Child sessions never run routing classification.

`max_turns` is a hard assistant-turn budget. The local host reserves the final
budgeted turn for a tool-free synthesis response. If a child reaches the budget
while continuing tool work, it is reported as
`cancelled` with `turn_limit_reached`; a provider failure is reported as
`failed` with `model_request_failed` instead. Parent cancellation, timeout,
and host shutdown have their own terminal error codes.

`list_subagents` returns compact status-only records and is bounded to 20
children by default, with a maximum of 50. Use `get_subagent_result` when the
full result or error for one child is needed. Result reads do not consume a
completion notice by default; pass `acknowledge_completion: true` after
handling a terminal result to suppress its still-pending notice.

Felan Code persists child session paths before the first model request. Completion
notices arriving before the next parent boundary are coalesced into one parent
turn, and a child continuation supersedes its prior undelivered notice. If the host
or process exits unexpectedly, a retained JSONL session can be continued
explicitly with `steer_subagent` under the same child identity. Interrupted
work is never replayed automatically, because tool side effects may already
have occurred. Completion notices are durable and retried after transient
parent delivery failures.

### Bundled agent types

- `general` — implementation and investigation; a classifier may choose its
  model tier, otherwise the call or parent supplies the model. Thinking comes
  from the call or parent.
- `explore` — low-tier, thinking-off, read-focused exploration.
- `reviewer` — correctness and regression review on the `high` model tier with
  inherited thinking.

Definition model settings take precedence over classifier-selected tiers and
tool-call model selections; otherwise a classifier tier is used when available,
followed by the tool-call model and parent model. Definition thinking takes
precedence over tool-call thinking, then the parent thinking.

### Custom definitions

Agent definition files use flat frontmatter plus a required prompt body:

```md
---
description: Review changes for correctness and regressions
model: high
thinking: high
max_turns: 20
timeout_seconds: 600
allow_nesting: false
---

Review the requested changes and report findings with file and line references.
```

`id` defaults to the filename. A custom definition can replace a bundled ID.
Definitions choose persona and model behavior; they do not grant a different
tool policy.

Local concurrency defaults to four children and maximum nesting depth defaults
to three. Configure them through `felanSubagents` in
[`settings.json`](configuration.md#settings).

## Shared task graph

The root and every nested subagent share one task graph stored with the root
session. Tasks have stable IDs, priority, acceptance criteria, lifecycle,
notes, prerequisite edges, ownership, and a required verified completion
result.

Important invariants:

- `blocked_by` edges must not create a cycle;
- only completed prerequisites make a dependent task ready;
- a session atomically claims a ready task by setting it `in_progress`;
- one worker owns at most one active task;
- stale claims require explicit forced recovery; and
- completion records a result, not only a status change.

Use `/tasks` or `Ctrl+Shift+T` for list, detail, ready-state, and graph views.

The graph is execution state for one root session. It is not a project issue
tracker or durable cross-session backlog.

## Prewalk

Prewalk is a same-session planner-to-implementer handoff. It can include a
tool-driven plan-approval checkpoint before its first focused edit.
Model-requested entry asks for user approval by default.

For complex repository work that benefits from substantial exploration,
coordinated multi-file changes, dependency-aware planning, or broad verification,
the model can call `enter_prewalk` for a new file-changing task. Conversation
or repository activity from earlier requests does not prevent entry. The model
should prefer to enter before exploring the current task; if its complexity
becomes clear after read-only exploration, it can still enter before the
task's first mutation. In a dialog-capable host, the default `ask` policy
prompts before entering; a denial leaves the model on the regular path. JSON
and print modes deny `ask` because interactive approval is unavailable. Small
localized edits and routine one-file fixes should normally stay on the regular
path. You can also enter explicitly without a redundant approval prompt:

```text
/prewalk refactor the parser and verify the tests
```

The default target is the `low` model tier at exact `medium` thinking. Tier
resolution stays on the current provider. If that provider has no authenticated
model in the target tier, Prewalk keeps the planner model and only reduces
thinking. Hosts or the declarative extension configuration can select another
tier or exact authenticated `provider/model`, and can override the
implementation effort with `off`, `low`, `medium`, `high`, `xhigh`, or `max`.
An explicit `provider/model-id` may cross providers. Pi clamps that request to
the target model's capabilities. The original planner model and thinking level
are restored after the run settles by default.

The optional `xhigh` model tier is intended for unusually complex architecture,
design, planning, difficult debugging, or high-stakes code review. It is
available to subagents and explicit Prewalk configuration, but is not a routine
default. This model tier is separate from the `xhigh` thinking level.

With a classifier, Prewalk makes four small decisions in root sessions:

- **Entry:** before each idle user turn, it judges whether the request needs
  Prewalk and, if so, adds a hidden conversation message telling the model to
  call `enter_prewalk` before exploring. The system prompt, tool, and
  `entryApproval` policy are unchanged.
- **Exploration depth:** when a run starts, it judges what the conversation and
  prior tool activity already cover. Planning guidance then says to plan from
  existing findings, inspect the specific missing files, or delegate broad
  discovery to `explore` children.
- **Implementation profile:** at handoff to a tier target, it may raise the
  configured tier and thinking level for a harder plan. It never lowers them.
- **Completion:** when the implementer's agent run is ready to settle, it
  judges the final response and evidence. If the work is done, the run settles.
  If there is a gap, a hidden follow-up asks the
  implementer to finish and verify it. If the result is uncertain, the follow-up
  asks for one high-tier reviewer. A `done` decision still requires successful
  verification after the last edit. At most two checks run per Prewalk run; if
  the second check still finds a gap, review is required. Prewalk retains the
  implementation model while verification or the reviewer is outstanding.

Without a classifier, the model decides entry and exploration itself, the
configured target applies, and implementation guidance always requests one
high-tier reviewer after verification. Prewalk does not check whether `Agent`
is available; the host must enable it for reviewer requests.

The `extensionConfig.prewalk.entryApproval` setting accepts `ask`, `allow`, or
`deny`. `ask` is the default; cloud or other unattended hosts can choose
`allow`. Felan Code also exposes it as the generated
`--prewalk-entry-approval` option and in `/settings`. This policy gates only
model-called `enter_prewalk`, not explicit `/prewalk`.

If a persisted value is no longer valid, the local host warns at startup and
uses the default `ask` without rewriting `settings.json`.

The `extensionConfig.prewalk.planReview` setting accepts `inherit`, `ask`, or
`skip`. The default `inherit` asks for plan review when `entryApproval` is
`ask`, and skips review otherwise. Explicit `ask` applies to every entry path,
including `/prewalk`. During review, the planner calls `exit_plan_mode` with the
complete concise plan. The tool displays that exact argument and lets the user
approve, provide feedback, or cancel Prewalk. Approval returns to planning so
the first focused mutation can trigger the configured handoff. Feedback keeps
planning active for a revised `exit_plan_mode` call, while cancellation exits
without implementation. The review boundary is model guidance rather than a
tool sandbox. JSON and print modes auto-approve required review with a warning
because they cannot accept interactive discussion.

The plan argument must be non-empty and no longer than 32,000 characters. In
the TUI, review opens fullscreen with a scrollable, theme-styled Markdown plan
pane and fixed actions, so long plans do not push the choices off screen. Use
the mouse wheel or trackpad, Page Up/Page Down, or Home/End to scroll the plan
and the select bindings to choose an action. The display copy is terminal-safe
while the original plan argument remains in model context. RPC mode retains the
host's select dialog.

### Lifecycle

1. The planner explores the relevant repository surface.
2. When both task tools are active, it creates a concise task graph and claims
   the first ready task.
3. When plan review is active, it passes a concise numbered plan to
   `exit_plan_mode`. The user can approve it, return feedback for another
   planning iteration, or cancel Prewalk.
4. It makes one focused successful `edit`, `write`, or Codex `apply_patch`.
5. At the turn boundary, Felan Code switches the next model request to a
   same-provider model in the configured target tier, or to an exact target, and
   applies the configured implementation thinking level. If the planner provider
   has no target-tier model, it keeps the planner model and only changes thinking.
6. The target sees the useful conversation and tool history, completes the
   task graph, and verifies the work.
7. Felan Code restores the planner selection after the run settles. Prewalk's
   temporary model and thinking changes are scoped to the active session and do
   not change the user's or project's default selection, so a new session keeps
   using the configured default model.

The default `medium` implementation effort prevents a cheaper target from
inheriting a planner's `max` effort. A same-model target with a different
effective effort is still handed off; only matching model and effective effort
are treated as a no-op. Manual thinking changes cancel Prewalk just like manual
model changes, including when they race an in-flight handoff or restoration.

Within planning or implementation, Prewalk injects the current hidden phase
guidance once at a stable context position while later responses and tool
results append after it. If the planner stops before useful tool progress,
Prewalk can append a short hidden continuation instead of repeating the full
planning instructions. Phase guidance is replaced at handoff and removed after
the run.

Shell commands do not qualify as the first mutation because they are also used
for exploration and verification. When both task tools are active, successful
`TaskCreate` and `TaskUpdate` calls claiming `in_progress` work must precede the
successful mutation; failed or unrelated task calls do not open that gate. If
the task tools are unavailable, mutation-only handoff remains available. A
failed mutation does not trigger handoff. Prewalk does not inspect `TaskList`,
`TaskGet`, todo, or Beads activity.

### When not to use it

Skip Prewalk for read-only research, explanation, review, or when you want one
model to perform the entire task. Plan review prevents the handoff mutation
through model guidance, not by disabling every tool capable of changing files.

See the package references for the [subagent protocol](../../packages/ext-subagents/README.md),
[task graph](../../packages/ext-tasks/README.md), and
[Prewalk lifecycle](../../packages/ext-prewalk/README.md).
