# ADR 0003: Cooperatively recover Codebase Memory sessions

> Status: Accepted
> Date: 2026-09-10
> Deciders: Felan maintainers
> Related: [Codebase Memory session transport](../maintainers/codebase-memory-stdio.md), [upstream issue #2015](https://github.com/DeusData/codebase-memory-mcp/issues/2015)

## Context

Codebase Memory 0.10.8 can retain a live, queryable daemon while rejecting every
new index worker because the daemon generation can no longer be verified. A
single Felan frontend restart does not recover this state when other root
sessions remain attached. Deleting upstream lock files or terminating reported
PIDs could instead create split-brain writers or affect processes Felan does not
own.

The recovery must work across independent Felan root sessions that share agent
storage, preserve the portable `AgentRuntime` boundary, remain bounded when an
older client does not cooperate, and leave Codebase Memory responsible for its
daemon, locks, and cache.

## Decision

Felan will coordinate its own Codebase Memory frontends through unique,
expiring recovery records in Felan-owned storage. A client starts a recovery
wave only after a bounded read of the referenced worker log confirms a known
fatal coordination signature. Participating clients fence new frontend
admission and close only their own frontend.

A recovery contender then invokes the reviewed binary's graceful `daemon stop`
control command with the same cache and runtime roots. Stop attempts are
bounded and may safely contend because the command is idempotent and refuses
while committed clients remain. An immutable success record must exist before
an interrupted operation can retry, and eligible operations retry at most once.

Felan will not delete Codebase Memory runtime files or cache data, signal
reported PIDs, reinstall the binary automatically, or broaden Agent Core's
process API for this recovery path.

## Alternatives Considered

- Restart only the failing frontend: rejected because another attached root
  session keeps the broken daemon generation alive.
- Delete runtime locks or kill daemon/client PIDs: rejected because filesystem
  presence and reported PIDs are not safe ownership authority.
- Wait for an upstream release: rejected because no released recovery contract
  currently prevents affected Felan sessions from remaining broken.
- Add a strict cross-process leader lease: rejected because unique expiring
  records and idempotent graceful stop avoid new stale-owner and ABA races.

## Consequences

- Fixed-version current sessions cooperatively drain; new sessions wait for the
  bounded wave and resume against a fresh daemon generation.
- Expired or abandoned waves never authorize transparent retry, and an older or
  otherwise uncooperative client produces an actionable failure instead of an
  infinite restart loop.
- Existing sessions must be restarted once to load the fixed extension; live
  code cannot be retrofitted into processes already running the old version.
- The extension adds a small recovery-channel poll while a client is active,
  but it does not add source-tree polling or periodic indexing.
- The protocol remains internal to `@felan-ai/ext-codebase-memory`; Agent Core's
  public runtime contract and the reviewed 0.10.8 binary pin stay unchanged.
