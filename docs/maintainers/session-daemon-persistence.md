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
initialization and must be included in backups.

Recovery distinguishes the file from its rows:

- A missing snapshot starts an empty store without quarantine.
- Other read errors (for example `EACCES`) fail startup with a retryable
  `storage_failure` and leave the file in place.
- Only a file that fails parsing, integrity (digest, sequence, store ID),
  schema, or namespace/agent-directory checks, or that was replaced by a
  symlink, is quarantined as `control-corrupt-<time>.json`; an empty store then
  starts, and transcripts remain listable and are re-adopted on attach.
- In an otherwise valid file, inconsistent rows are dropped individually with
  the rows that depend on them (descendant sessions, requests, interactions,
  continuations and resources). A row whose transcript path no longer has the
  same canonical identity is dropped the same way.
- A row whose session directory lies outside the current store roots (for
  example after `daemon-store-roots.json` was lost) is kept, and its directory is
  owned again at startup. It is dropped only if that directory cannot be owned.

Deleting a session tombstones it and every registered descendant and removes
all of their transcripts.
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

The snapshot has no byte or session-count cap. Admission bounds only in-flight
work (pending requests and their bytes), keeping a small reserve so cancellation,
interaction resolution, close and drain can still be admitted under load.

A protocol-valid request up to the protocol frame limit is canonicalized by the
protocol parser, then stored as SHA-256 plus canonical encoded length. Prompt,
image, shell/config payloads and arbitrary extra fields are not copied into the
control snapshot. The record includes the normalized ID, stable owner principal,
operation, session, admission time, retention deadline, phase and sanitized
terminal response. Pass a **stable retry principal**, not an ephemeral attachment
ID. A reconnecting authorized attachment must map to that same principal.
Identical retries return the record; changed payload/principal conflicts.
Request IDs are not rejected for age or clock skew. Terminal records are pruned
seven days after the later of admission time and the ID's UUIDv7 timestamp.

Coalesced projections are capped at 256/session. Session revision high-water
and nonterminal records are not age-evicted.
Resolved interaction/completed-continuation/exited-resource and request records
have a minimum seven-day retention window; `compact` removes expired records and
old terminal projections. Call it periodically from lifecycle management.
Indeterminate continuations retain their winning answers indefinitely; unresolved
resource identities are not age-evicted.
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

Unregistered Pi transcripts in pre-daemon layouts are discovered while listing
and adopted in place when a client attaches to one. Discovery scans only
`agentDir/sessions` (top level and its `--<encoded-cwd>--` directories; a
cwd-filtered listing reads only that cwd's directory) and the top level of each
other owned store root, such as a custom `--session-dir`. It reads at most a
64 KiB first-line header from regular files, validates it with the import
header schema and Pi's session-ID syntax, and lists it like Pi's
`SessionManager.listAll` regardless of file mode, link count or whether its cwd
still exists. Registered IDs and paths and duplicate IDs are skipped. A row's title is the latest Pi `session_info` name within the same
64 KiB prefix, else a 120-character snippet of the first user message there,
else empty (clients then show the ID). Listings reuse one discovery result for
two seconds so pages stay consistent; adoption always rediscovers.

Adoption registers the existing ID and canonical file path in control state
without copying, and continuation appends to that file through the normal resume
path, ownership checks and path claims. Adoption rediscovers the file by ID, so a
transcript replaced after listing is adopted from its current file; there is no
quiet window. After adoption the daemon is the only supported writer; running a
pre-daemon binary on the same session concurrently is unsupported. Explicit
import copies history into a new daemon session without changing the source
(the source must start with a session header), and export remains available.
Older binaries must not write daemon-owned control data; use separate roots and
verified backups when downgrading.

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

Any session may be deleted; the client asks for one confirmation, as in 0.28.3.
There is no expected-revision or closed/evicted/idle precondition: the registry
first closes the session tree (cancelling its run), then `markSessionDeleted`
commits the request's dispatch intent and the `deletedAt` tombstone, and the
exact transcript file is unlinked. No directory, child store, legacy original,
detached output or retry history is recursively removed.

The tombstone keeps request retries idempotent and stops later requests from
reopening the session. Ordinary updates cannot clear it. Tombstones are pruned
with their request records after the normal seven-day retention once no
request, interaction, continuation, resource or descendant references them.
Deletion is permanent, not trash or undo; the client must warn before confirmation.
