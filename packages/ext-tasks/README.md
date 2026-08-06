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
views. Headless and cloud sessions use the same tools and storage without
registering TUI controls.

## Development

Source: `packages/ext-tasks` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-tasks build
pnpm --filter @felan-ai/ext-tasks type-check
pnpm --filter @felan-ai/ext-tasks test
```
