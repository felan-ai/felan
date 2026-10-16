# ADR 0039: Store daemon control state in SQLite and keep tool and status views live-only

## Status

Accepted. Replaces the whole-file control snapshot described in
[session daemon persistence](../maintainers/session-daemon-persistence.md).

## Context

The daemon persisted its control state as one checksummed JSON snapshot. Every
commit cloned the whole state twice, validated it, serialised it twice, hashed it,
and wrote and fsynced the whole file.

The snapshot also held coalesced tool and status projections. Tool projections
carried each tool's output, so a long-lived account stored about 9 MB of tool
output (85% of a 10.6 MB file) that already existed in the Pi transcripts. Session
history is read from those transcripts; the stored rows only fed the recent tool
list in attach snapshots. Status projections existed only to force a durable
revision for changes such as `executions.changed` and `catalog.updated`.

Measured on that account: each commit took about 220 ms. Five running subagents
produced about four commits per second, which kept the daemon at 100% CPU. Every
other request queued behind them: listing 653 sessions took 15–19 s instead of
31–64 ms, and opening a session took 30–60 s.

## Decision

Tool cards and status changes are live-only. `SessionProjection` keeps them in
memory and publishes them with transient revisions, like presentations. A tool's
durable record is its result in the Pi transcript. Message identity references
and the pending queue record remain durable.

Control state is stored in `<agentDir>/daemon-control-v2/control.sqlite` using
Node's built-in `node:sqlite`, in WAL mode with `synchronous=FULL` and
`fullfsync`, which keeps the full flush the JSON store got from Node's `fsync` on
macOS. Each session,
request, interaction, continuation, resource and projection is one row with an
order column. The in-memory state remains the read model. Committed rows are
frozen and shared with each commit's draft, and a commit writes only rows whose
content or position changed, in one transaction; a commit that changes nothing
writes nothing. Changed rows are validated individually; cross-row references are
rechecked for every row.

The first start with an empty default store imports a verified
`daemon-control-v1/control.json`, without its tool and status projections. The v1
files are left in place and marked `migrated-to-v2.json`, so they are never
imported again.

`node:sqlite` is loaded only when the store opens, and its one-time
`ExperimentalWarning` is suppressed so foreground daemon output stays clean.

## Consequences

- Commit cost depends on the change, not the account. On the same data the state
  is 2 MB and a session update takes about 4 ms on an Apple SSD, of which about
  3.4 ms is the full flush; the JSON store paid the same flush per commit.
- Running work no longer commits for tool output, status or executions changes.
- After a daemon restart, or after an idle session is unloaded and reopened,
  attach snapshots no longer list tools from before; their results remain in
  history. A tool interrupted by a crash appears
  as a call without a result, as it did before the daemon.
- The store depends on `node:sqlite`, available unflagged on the supported Node
  lines but still marked experimental there.
- Downgrading uses the old `daemon-control-v1` state as it was at migration.
  Sessions registered afterwards are rediscovered as unregistered transcripts.
  Request outcomes recorded after migration are missing there, so a client that
  retries such a request ID against the downgraded daemon can run it again.
  Upgrading again resumes the SQLite state and ignores changes made while
  downgraded.
- Database files are owner-private. WAL lets read-only tools inspect the store while
  the daemon runs; an external writer holding a lock for more than a second fences
  the store, as any failed commit does.
