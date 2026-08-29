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

Local TUI sessions expose `/tasks` and `Ctrl+Shift+T` for list, detail, and graph
views. The compact footer status presents three unlabeled counts in Kanban order:
not started, in progress, and done. `/tasks` retains ready, blocked, waiting,
cancelled, and dependency details. Details group lifecycle, execution, dependency,
work-context, and timeline information. Related tasks show their availability
and title, while the graph shows both prerequisite and dependent directions.
Headless and cloud sessions use the same tools and storage without registering TUI
controls.

The interactive view defaults to inline rendering with two full-width horizontal
separators. Set
`extensionConfig.tasks.displayMode` to `overlay` for a centered popup:

```json
{
  "extensionConfig": {
    "tasks": { "displayMode": "overlay" }
  }
}
```

The setting is applied when a new runtime is constructed. It is also available
through `/settings` and as `--tasks-display-mode overlay`.
Overlay mode uses a complete four-edge frame.

## Installation and composition

```ts
import tasksExtension from '@felan-ai/ext-tasks';

const extension = tasksExtension;
```

The package owns the root-session graph, persistence, dependency validation,
task tools, and optional TUI view. The host supplies `AgentRuntime.storage('session')`
and session identity; task execution remains outside this package and may use
any available agent mechanism.

## Package boundary and requirements

The graph is execution state for one root session, not a project issue tracker.
It has no remote synchronization, due dates, labels, comments, or durable
cross-session backlog. The package requires a compatible
`@felan-ai/agent-core` peer, TypeBox, and Pi-TUI.

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
