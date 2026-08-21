# Agents, tasks, and Prewalk

Felan separates three concerns that are often represented by one generic
“agent” feature:

- **subagents** execute independent work asynchronously;
- **tasks** record dependency-aware shared execution state; and
- **Prewalk** routes one useful session from planning into implementation.

They work together, but each remains usable on its own.

## Asynchronous subagents

The `Agent` tool queues a child and returns immediately. The root can continue
working, then list, inspect, steer, continue, or cancel direct children. Felan
delivers a completion notice when a child finishes.

The portable extension exposes exactly five tools:

- `Agent`
- `list_subagents`
- `get_subagent_result`
- `steer_subagent`
- `cancel_subagent`

The local host owns admission, persistence, nesting, cancellation, model
selection, and completion delivery. `/agents` or `Alt+A` opens live and stored
child transcripts in the TUI.

### Bundled agent types

- `general` — implementation and investigation using the inherited model and
  thinking unless the call selects otherwise.
- `explore` — low-tier, thinking-off, read-focused exploration.
- `reviewer` — correctness and regression review using the inherited model and
  thinking.

Definition settings take precedence over tool-call model/thinking selections;
unspecified values fall back to the call and then the parent.

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

Prewalk is a same-session planner-to-implementer handoff. It is not a read-only
plan mode and does not introduce an approval gate.

For an ordinary file-changing request the model can call `enter_prewalk` before
exploration. You can also enter explicitly:

```text
/prewalk refactor the parser and verify the tests
```

The default target is the `low` model tier; hosts or flags can select another
tier or exact authenticated `provider/model`. The original planner model and
thinking level are restored after the run settles by default.

### Lifecycle

1. The planner explores the relevant repository surface.
2. It creates a concise task graph and claims the first ready task.
3. It makes one focused successful `edit`, `write`, or Codex `apply_patch`.
4. At the turn boundary, Felan switches the next model request to the configured
   target.
5. The target sees the useful conversation and tool history, completes the
   task graph, and verifies the work.
6. Felan restores the planner selection after the run settles.

Shell commands do not qualify as the first mutation because they are also used
for exploration and verification. A failed mutation does not trigger handoff.
Task use is directed by Prewalk guidance but not enforced by its state machine.

### When not to use it

Skip Prewalk for read-only research, explanation, review, or when you want one
model to perform the entire task. Use a conventional plan/approval workflow in
another host if you require a non-mutating plan artifact before any edit.

See the package references for the [subagent protocol](../../packages/ext-subagents/README.md),
[task graph](../../packages/ext-tasks/README.md), and
[Prewalk lifecycle](../../packages/ext-prewalk/README.md).
