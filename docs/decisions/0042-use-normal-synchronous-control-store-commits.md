# ADR 0042: Use NORMAL synchronous control-store commits

## Status

Accepted. Supersedes the per-commit durability choice in
[ADR 0039](0039-store-daemon-control-state-in-sqlite.md).

## Context

`node:sqlite` commits synchronously, blocking the daemon event loop and every
session's stream. An earlier 200-commit investigation on an Apple M5 Pro running
macOS 26.6.2 measured WAL commits with `synchronous=FULL` and `fullfsync=ON` at
3.9 ms p50 and 9 ms p99. Disabling `fullfsync` measured 63 µs p50; NORMAL with
`fullfsync=OFF` measured 14 µs p50, not the shipped configuration below. A prompt
reply took 17–29 ms, including 14–21 ms for 4–6 commits; `set_thinking` took
13–14 ms, including about 10 ms for three commits. A plain text turn made 8–13
commits. These are observed workloads, not latency guarantees.

Pi transcripts are the content authority, but their synchronous file writes and
appends do not fsync. Control-state durability therefore exceeded transcript
durability without making effects and their control records atomic.

## Decision

Use WAL with `synchronous=NORMAL`. Retain `fullfsync=ON` and
`checkpoint_fullfsync=ON`: SQLite's remaining syncs, including checkpoints and
WAL-header reuse, keep macOS `F_FULLFSYNC`. The checkpoint flag is redundant while
`fullfsync` is enabled but explicitly preserves the checkpoint policy. NORMAL
removes the per-commit WAL sync; keeping `fullfsync` does not restore FULL's
per-commit latency or power-loss durability. Checkpoints still sync the WAL
before copying and the database afterwards.

Accept rollback of recent committed control state after an OS crash or power
loss. There is no fixed time or commit-count bound on the loss window. A daemon
or process crash alone preserves committed transactions. SQLite WAL consistency
and transaction atomicity remain intact; this is weaker durability, not partial
row writes. See SQLite's [synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)
and [checkpoint_fullfsync](https://www.sqlite.org/pragma.html#pragma_checkpoint_fullfsync)
documentation.

## Alternatives considered

- Keep FULL and fullfsync: preserves per-commit power-loss durability at the cost
  of blocking all sessions for each storage flush, despite unsynced transcripts.
- Keep FULL but disable fullfsync: faster on the measured Mac, but weakens its
  hardware flush guarantee while retaining a per-commit sync. NORMAL explicitly
  chooses checkpoint durability instead.
- Disable synchronous writes entirely: rejected; NORMAL retains the syncs needed
  for WAL crash consistency and durable checkpoints.

## Consequences

- Reproduce with `node perf/run.mjs daemon` (see [methodology](../../perf/README.md)).
  On 2026-10-16, the same hardware with Node 22.20.0 and SQLite 3.50.4 measured
  COMMIT only after one prepared row upsert in `BEGIN IMMEDIATE`, with a fresh
  on-disk database per case, 100 warm-up commits and 1,000 measured commits.
  `sqlite.FULL-fullfsync.commit` measured 3,003 µs p50 / 5,944 µs p99;
  `sqlite.shipped.commit`, matching all store pragmas, measured 5.25 µs p50 /
  8.83 µs p99. Default `wal_autocheckpoint=1000` remained enabled. The shipped
  case's maximum was 7.04 ms: checkpoints and WAL reuse can still block. This
  longer run differs from the earlier investigation and does not measure
  whole-request latency or promise uniformly cheap commits.
- Request deduplication is only as durable as its admission record. If that
  record is lost, a retry with the same ID can be admitted and run again. If the
  admission survives but dispatch intent is lost, recovery sees `intent` and
  returns `unavailable` without rerunning it, even if its effect already happened.
  If dispatch intent survives but the terminal outcome is lost, recovery returns
  `indeterminate`. Surviving terminal records keep their original outcomes.
  There is no exactly-once guarantee across loss of committed state.
- The same limit applies to interaction answers and continuations. A surviving
  `ready` continuation whose later dispatch intent was lost can be resumed by
  the broker automatically and repeat an effect. A surviving dispatch intent
  instead recovers as `indeterminate`. Commit-before-effect ordering prevents
  replay after a process crash, not after an OS crash that loses that commit.
- `transientRevisionCeilings` reserves blocks of 4096 in session rows. If the
  latest reservation or a newer unreserved durable revision is lost, restart
  can expose revisions below those already published. Recovery only advances
  restored revisions for changed sessions; it cannot recover the lost high-water
  mark. Monotonicity across daemon/process restarts remains, but is not guaranteed
  across OS crashes or power loss. Reconnects must treat their new snapshot as
  authoritative, not assume an old revision proves it stale.
- Control metadata, deletion tombstones and content can disagree after power
  loss. Existing recovery and Pi reconciliation remain best effort and never
  prove an external effect did not occur. No schema, request ordering, retention
  or migration changes accompany this decision; backups and downgrades retain
  the existing caveats.
