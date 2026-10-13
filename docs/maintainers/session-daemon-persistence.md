# Local daemon control persistence

S1.04 supplies internal persistence/recovery primitives, not an entrypoint
cutover, registry, interaction broker, or execution engine. The existing Pi JSONL
and tree remain the content authority. No dependency or public export/version is
added. Windows remains unsupported by the ownership prerequisite.

## Files and durability

`DaemonControlStore` takes an acquired `DaemonOwnership`. Its default directory is
`<agentDir>/daemon-control-v1`, inside the canonical startup root set. Every path
uses the return value of `assertOwnsPath`; every commit synchronously rechecks
ownership and retained directory/file identities, including after fault hooks.
The store never acquires/releases ownership for its caller. Close the store and
settle **all** session/descendant writers before releasing the owner, including
after fencing or a failed disk write.

The primitive is an owner-private, checksummed, versioned JSON snapshot. A commit
writes a unique 0600 no-follow temporary file, fsyncs it, atomically renames it,
then fsyncs the containing directory. Returned revisions/outcomes may be
published only after that sequence returns. Before first use, a separate private
`<agentDir>/.control-initialized-<SHA-256-of-control-directory>.json` records the
store identity. It is outside the control directory, is synced before control
initialization and must be included in backups. A previously initialized store
with a missing directory, missing format/snapshot pair, corrupt or unknown-version
snapshot fails closed; no empty store or backup snapshot is silently substituted.
The control directory cannot contain the agent directory/initialization record.
Initialization syncs created directory entries through their owned parent chain.
Incomplete temporary snapshots are never recovery candidates. An I/O error
permanently poisons that handle, even when the rename
may have succeeded. Stop admission, settle writers and reopen/reconcile; never
infer failure means the operation is safe to repeat.

This deliberately uses built-in filesystem/crypto facilities, not another native
database dependency. The bounded snapshot makes the atomicity boundary explicit.
Whole-file synchronous commits trade throughput for a small, auditable primitive;
coalesce high-volume tool/status changes before committing. This is not a general
transcript database, platform outbox, event archive or persistence framework.

## Bounds and identities

The entire encoded snapshot is limited to 16 MiB. Ordinary mutations leave
1 MiB + 4 KiB + 1 KiB for a complete safety admission: its maximum outcome,
bounded identity/phase row, and commit bookkeeping. Request metadata is checked
against that 4 KiB bound before writing; configurations cannot reduce this safety
floor. Every pending request additionally reserves 1 MiB for its
terminal response, including maximum-size validated blocker identifiers and JSON
escaping. Every pending interaction reserves its maximum answer plus 1 KiB of
terminal metadata. These byte limits may reject well before the maximum record
counts: 100,000 requests/session, 1,000,000/namespace, with 1,024 namespace slots
reserved for cancellation, interaction resolution, close and drain, with equivalent
headroom within each session. Smaller byte/count bounds are allowed only while
preserving the complete safety floor; larger bounds are rejected. Full capacity never
evicts still-retryable records to admit new work.

A protocol-valid request up to the protocol frame limit is canonicalized by the
protocol parser, then stored as SHA-256 plus canonical encoded length. Prompt,
image, shell/config payloads and arbitrary extra fields are not copied into the
control snapshot. The record includes the normalized ID, stable owner principal,
operation, session, admission time, retention deadline, phase and sanitized
terminal response. Pass a **stable retry principal**, not an ephemeral attachment
ID. A reconnecting authorized attachment must map to that same principal.
Identical retries return the record; changed payload/principal conflicts. The
UUIDv7 timestamp remains the freshness authority. Terminal records are pruned
only after both admission time and ID timestamp age beyond seven days. A durable
clock high-water prevents clock rollback from reviving an expired request.

The schema caps sessions at 4,096, interactions/continuations at 1,024,
resources at 4,096 and coalesced projections at 256/session. Session revision
high-water and nonterminal records are not age-evicted.
Resolved interaction/completed-continuation/exited-resource and request records
have a minimum seven-day retention window; `compact` removes expired records and
old terminal projections. Call it periodically from lifecycle management.
Indeterminate continuations retain their winning answers indefinitely; unresolved
resource identities are not age-evicted. These records can instead block capacity.
Message references/tool/status projections
may be compacted without invalidating Pi content or retry protection. No full
completed message, tree, raw process environment, provider credential, control
token or command payload is stored here. Tool/status text and serializable user
answers must already be appropriate for durable local presentation: callers
must not pass credentials as presentation text. OAuth URL/credential interactions
are explicitly rejected from this store; their presentation stays transient,
with interruption recorded on their owning operation.

## Integration order

1. Acquire canonical owner/root claims. Open the store. When `needsRecovery` is
   true, call `recover()` before mutation admission; reads are allowed earlier.
   Recovery is startup-only and cannot interrupt a live store a second time.
2. Resolve and validate the request and authorization. `admit()` commits only its
   identity/intent and reserves outcome capacity. A returned old record is not
   dispatch authority. Reads and connection-only operations have no durable
   mutation record here.
3. After policy/trust/registry checks, `markDispatched()` commits dispatch intent.
   Only then invoke the effect. Recheck ownership after every asynchronous gap
   before dispatch. A thrown persistence error forbids dispatch.
4. Use `finishRequest()` and publish its **returned** sanitized response.
   Free-text errors are sanitized; validated `retryAfterMs`, `sessionId` and
   `blockers` are preserved through publication and reload. Accepted
   effectful responses require dispatch intent. Pending requests are never
   transparently retried. Publication/network delivery is outside this store.
5. `createSession`/`updateSession` persist lifecycle, model, branch and monotonic
   policy. `project` coalesces by stable message/tool/status/queue ID and assigns
   one session revision per batch. Commit text streams nowhere here. Registry
   projection builds snapshots from these records plus the authoritative Pi
   manager and in-memory text prefixes; revisions are not an event replay log.
6. `putResource` records root/session-scoped child/process identity, optional
   runner record path, PID and birth identity. It is not authority to signal a
   PID. S1.06 must verify the existing runner/process identity and reconcile,
   never recreate a PTY/process/child from this row.

Registry/profile integration retains the final S1.05 contract: resolve target,
claim source/destination, re-resolve canonical identity/cwd under the claim,
verify the actual loaded manager before effects, and use its actual session ID.
This store does not open a manager or choose a different root-session identity.
`ControlSession.piPath` must be the canonical file returned by that process.
The profile and this store have no per-session environment provisioning records.

### Internal safety lifecycle transitions

S1.06 adds `transitionSessionForSafety(id, transition)` for the fixed selectors
`cancelling`, `idle`, `closed` and `evicted`. It uses the existing validated safety
commit and its full byte, reservation, ownership, recovery and poisoned-handle
checks. It does not change ordinary `updateSession` or `project` capacity, grant a
generic safety flag, or release any request outcome reservation.

Cancellation requires an active run with an ID in an open session. Closing and
eviction reject active run states. The registry must additionally prove runtime,
writer, child, process and interaction quiescence; a stored idle flag is not that
proof. The registry compares the current run ID before applying a settlement
callback. The fixed patches preserve run ID/origin, policy, paths, lineage,
projections and unrelated records. Eviction only changes residency. Closing also
sets the run idle, without reopening a closed session. Unknown selectors fail.

Repeated valid transitions retain the same session revision and return no touched
revision; they still pass through the guarded commit. A changing transition returns
its committed state/revision before publication. Cancellation commits before abort,
and idle commits only after the relevant runtime and admitted effect settle.
Optional capacity-blocked projection reconciliation retains its observations and
retries automatically; storage, ownership and validation failures are not treated
as transient capacity pressure. Pi remains the durable content authority.

## Recovery and the Pi/control split

Recovery changes intent-only requests into explicit undispatched rejections and
`dispatch_intent` into `indeterminate`; it never invokes an effect. Already
committed accepted outcomes stay accepted even if the run was subsequently
interrupted. Warm sessions become evicted, running turns/tools become interrupted,
PTY/foreground references become missing and child references interrupted.
Detached references become `reconciling` with their old runner identity intact;
S1.06 must verify reality before enabling writes or claiming termination.

`reconcilePi` accepts bounded stable message/entry identities observed in a pinned
Pi view. It stores no message content and never treats a message as proof that a
request completed. A Pi-first message-end can add its missing control reference;
a control-first reference whose entry is provably absent becomes `missing`.
The caller must supply `absentEntryIds` only after actually proving absence in
the relevant complete/pinned view, never from a partial history page. The new
revision is committed before publishing recovery state. No boundary reruns the
model, shell or request to make the two stores agree. Queue records contain IDs
and a payload digest, not executable queued prompts; lost in-memory queues are
reported as interrupted/unavailable, never reconstructed and automatically run.

## Interaction and continuation ordering

`putInteraction` commits a pending serializable interaction. Before any wait may
be published, its encoded definition must leave 64 KiB plus 1 KiB of terminal
metadata within the protocol's 256 KiB interaction record limit. A larger,
otherwise protocol-valid definition is rejected with `request_capacity` before
publication, rather than asking a question whose valid answer cannot be saved.
This local admission constraint does not change the public protocol schemas or
truncate questions/answers. The later broker
owns authorization, subscriptions, timeouts and notification. `answerInteraction`
checks the admitted answer identity, responder eligibility, scope, schema,
expiry and unresolved state, then commits the winner, response, revision and
optional ask-user continuation **together**. It returns only after durable commit.
A failed write must not notify a winner or resume a callback.

Only answered session `ask_user` interactions may create restart-replayable
continuations. `ready` means no dispatch intent has ever been committed;
`transitionContinuation(..., 'dispatch_intent')` must return before dispatch.
Recovery exposes only those proven-undispatched ready IDs, and only for an open
session with the committed answer. It does not dispatch them. A committed
`dispatch_intent` becomes `indeterminate`; the winning answer is retained.
Completed/indeterminate/cancelled continuations cannot transition again.
`cancelInteraction` persists timeout, abort, unsupported, drain and restart outcomes without overwriting a winner. Live callbacks/tool approvals/OAuth are not rebuilt as user prompts. Restart
cancels nonreplayable pending interactions, defers pending ask-user requests
(default 30 minutes when no explicit expiry exists), and preserves existing
terminal results. Later drain orchestration must use the same durable ordering.

## Pre-daemon files and downgrade

Pre-daemon files are not discovered or resumed. Explicit import validates and
copies history into a new daemon session without changing the source. Export
remains available. Older binaries must not write daemon-owned transcripts or
control data; use separate roots and verified backups when downgrading.

## Verification scope

Deterministic disposable-root tests cover each atomic write boundary, corrupt/
missing/versioned snapshots, count/byte reserves, retry conflicts/expiry/clock
rollback, coalesced revisions, policy monotonicity, interaction winners, committed
answers and continuation ambiguity, and explicit import boundaries. Spawned offline
fixtures SIGKILL themselves at real intent/dispatch/effect/outcome, answer/
continuation and Pi/control boundaries; reload assertions inspect actual files.
There is no provider/network call or live user config/store/process access.
All app build/type-check/test blocks hold the shared Story 1 `fcntl.flock`.
Platform evidence and exact commands/results are in the S1.04 review artifacts;
this document does not claim integration/packed/Linux coverage by implication.

## Deletion tombstones

`markSessionDeleted` atomically commits its matching request's dispatch intent and
the optional `deletedAt` timestamp. It compares the admitted expected revision
inside that commit and requires a previously closed, evicted, idle session tree
without pending requests, active resources, interactions or continuations. It
uses ordinary capacity accounting, not the general safety bypass: at full
ordinary capacity deletion rejects before either tombstone or unlink, preserving
other outcome, interaction and emergency reserves.

The row, lineage, transcript path and policy remain. Obsolete projections are
cleared atomically with the tombstone; terminal request outcomes retain the normal
bounded retention window and expire normally. An expired request ID cannot be
admitted again, so pruning cannot enable late replay. Ordinary updates cannot
clear a tombstone or reopen it.
Tombstones consume the existing 4,096-session limit permanently. Only a separate
verified exact-file unlink follows the commit; no directory, child store, legacy
original, detached output or retry history is recursively removed. A failure
after committing the tombstone is indeterminate, with no automatic retry. A new
explicit request can retry exact-file removal without replacing the tombstone.
Deletion is permanent, not trash or undo; the client must warn before confirmation.
