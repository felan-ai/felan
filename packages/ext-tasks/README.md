# @felan-ai/ext-tasks

Dependency-aware task tracking scoped to one Felan root session. The extension
registers `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet`. Tasks have stable
IDs, hard prerequisite edges, priorities, acceptance criteria, ownership,
handoff notes, and terminal results.

Task state lives under `<session-storage>/tasks/state.json`. The root session and
all of its subagents use the same `AgentRuntime.storage('session')` namespace,
so every worker sees the same graph without a task-specific subagent protocol.
Mutations are serialized per storage root within a Felan host process, and
`TaskUpdate` atomically claims a ready task for its calling session when setting
`status: "in_progress"`. A cloud host that distributes one root session across
multiple processes must provide equivalent root-scoped serialization.

The task graph is execution state rather than an issue tracker. It has no
project backlog, remote synchronization, comments, labels, estimates, or due
dates. Work that must outlive the root session belongs in Beads, Jira, Linear,
or another persistent tracking system.

## Tools

- `TaskCreate` creates a pending task and returns its stable ID.
- `TaskUpdate` edits metadata and dependencies or changes lifecycle status.
- `TaskList` returns the current, ready, active, blocked, pending, completed, or
  full task view.
- `TaskGet` returns one task with prerequisite and dependent details.

Only completed prerequisites satisfy a dependency. Dependency cycles are
rejected. Multiple sessions may own work concurrently, while each session may
claim at most one task at a time. A session cannot change another session's
active task unless it explicitly requests stale-claim recovery with `force`.

The package root exposes `/tasks` through common `pi.ui` views and documents,
with an optional `felan.tasks` version `1` hint and no feature-specific UI service. TUI clients also
register `Ctrl+Shift+T`. The compact footer status presents three unlabeled counts in Kanban order:
not started, in progress, and done. `/tasks` retains ready, blocked, waiting,
cancelled, and dependency details. Details group lifecycle, execution, dependency,
work-context, and timeline information. Related tasks show their availability
and title, while the graph shows both prerequisite and dependent directions.
Headless and cloud clients use the same tools, storage, and common presentation;
an unavailable common UI fails explicitly. Keyboard shortcuts remain TUI-only.

The overview shows 20 rows per page with IDs, complete titles, priorities,
statuses, availability, ownership, blockers, and timestamps. Declared actions
filter by the standard task views, search titles and IDs, page results, refresh,
and open details. Detail documents show all work fields, dependencies and
dependents, ownership, and timestamps, with related-task navigation and 128 KiB
Markdown pages. Changing between overview and detail closes the old handle and
presents a new element; handles never change kind. Untrusted text is escaped,
not silently truncated.

Explicit create and update actions collect the same fields as the task tools.
Updates can claim, release, block, complete, cancel, or reopen tasks, edit work
metadata and dependencies, and explicitly request stale-claim recovery. They
use the viewing session as actor and retain all graph and ownership checks.
Each action validates its declared fields, element revision, current page,
and a fresh task snapshot. Subscriptions refresh open views after changes.
Cancellation closes the UI and drains owned work before the store closes.

The store has no conditional-write or cancellable-write API. Its existing
serialization and fresh graph validation remain authoritative; a concurrent
write after the UI's snapshot check is not an atomic revision conflict.
Cancellation before dispatch prevents mutation, but a mutation already queued
inside the store may still commit. The UI does not claim to roll it back.

Felan's optional native task panel defaults to inline rendering with two full-width horizontal
separators. Set
`presentation.tasks.displayMode` in `$FELAN_AGENT_DIR/tui/settings.json` to `overlay` for a centered popup:

```json
{
  "presentation": {
    "tasks": { "displayMode": "overlay" }
  }
}
```

The setting belongs only to the TUI, with a read-only fallback to the released
`settings.json` value. It is also available
through `/settings` and as `--tasks-display-mode overlay`.
Overlay mode uses a complete four-edge frame.

## Installation and composition

```ts
import tasksExtension from '@felan-ai/ext-tasks';

const extension = tasksExtension;
```

The default export and `createTasksExtension()` own execution and portable
common-UI presentation without loading a TUI. Native rendering belongs to
`apps/felan`; the package exports neither a TUI entrypoint nor a presentation
service. `displayMode` applies to the optional client panel; generic layout
belongs to the client.

The portable adapter publishes generic elements and actions. Overview data and
selected details remain separate; large notes and results are not copied into
every task row.

The package owns the root-session graph, persistence, dependency validation,
task tools, and generic UI. The host supplies `AgentRuntime.storage('session')`
and session identity; task execution remains outside this package and may use
any available agent mechanism.

## Package boundary and requirements

The graph is execution state for one root session, not a project issue tracker.
It has no remote synchronization, due dates, labels, comments, or durable
cross-session backlog. The package requires a compatible
`@felan-ai/agent-core` peer and TypeBox.

## Development

Source: `packages/ext-tasks` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-tasks build
pnpm --filter @felan-ai/ext-tasks type-check
pnpm --filter @felan-ai/ext-tasks test
```

## Related documentation

- [Agents, tasks, and Prewalk](../../docs/user-guide/agents-tasks-and-prewalk.md)
- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Attribution

The interaction design was informed by the MIT-licensed `pi-todo-write` package
and the open-source Beads task tracker; no Beads source or CLI is included.
TypeBox attribution is recorded in [NOTICE](NOTICE); see [LICENSE](LICENSE) for
the package license.
