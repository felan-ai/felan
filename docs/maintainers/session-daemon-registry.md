# Daemon registry and runtime ownership

S1.06 adds internal host modules, not an entrypoint cutover or a session server.
The existing in-process application remains unchanged. S1.07 owns external
admission, authorization, fan-out and snapshot/subscription cutover; S1.08 owns
interaction callbacks/continuation dispatch; S1.09 owns complete extension
composition; S1.14 owns process-level management.

## Construction and lifetime

`SessionRegistry` requires the **same already-held** `DaemonOwnership` and
`DaemonControlStore`, a profile and a session-service factory. It recovers a
reopened control store before opening sessions or accepting work. It never
releases ownership, closes the store or disposes the externally supplied profile.
The caller must await registry shutdown and all service/writer settlement before
those operations. A fenced registry rejects further admission; `settleWriters()`
waits for its abort/settlement path. A failed shutdown is not permission to release
an owner while an unverified writer might remain.
The barrier joins already-started cancellation continuations, not merely a second
abort call, and retains cancellation failures after their promises finish.

- `create` opens a new/forked/cloned/imported binding through the profile.
- `restore` opens a registered session by its actual Pi manager ID and canonical
  file/cwd. Concurrent restores share one opening. It restores the recorded
  branch via the public manager API, refreshes the AgentSession context, and
  restores its active tool loadout before exposing the binding. No prompt, shell
  or continuation is replayed.
- `list` returns internal control records. The server maps/paginates summaries.
- `attach` returns an attachment ID and snapshot. `detach` removes that binding
  only, including when the last client leaves.
- `runAdmitted` is an internal dispatch port, **not** an authorization boundary.
  It requires an existing request intent, commits dispatch intent and run state
  before calling the effect, and never redispatches an old request. S1.07 still
  owns outcome commits and externally visible acceptance.
- `cancel` aborts the addressed foreground session run and its pending waits.
  It commits cancelling before abort and waits for admitted writers before
  publishing idle. It does not cancel independently spawned children or detached jobs.
- `close` settles the selected session, its descendants, foreground/PTY handles
  and registered services. It retains history and independent detached-job rows.
  Closing a child does not terminate its parent's unrelated handles.
  Concurrent closes share one operation and its result, including failures.
  Close intent survives an already-started idle eviction or opening.
- `evictIdle` disposes only an eligible idle binding, never history. Attachments,
  admitted work, queues, live/unresolved processes, pending children and
  nondeferred interactions prevent eviction. Registered daemon services
  conservatively retain residency; detach never stops memory/service work.
  Tracked filesystem, storage and exec operations also retain residency, even
  without a process row. Disposal drains its own session scope before revocation.
- `shutdown` settles bindings/services and leaves sessions open but evicted for
  later restoration. It is not a synonym for explicit session close.

Pi deliberately postpones writing an empty session until conversation starts.
Before such a binding can be registered as restorable, the registry settles and
releases that binding, saves its complete public header/setup-entry view to an
exclusive owned file, syncs file and directory, then opens it through the profile.
This preserves the actual ID without inventing a user message or mutating Pi's
private `flushed` state. Failure leaves an explicit setup error, not replayable
execution. Nonempty Pi transcripts are never reconstructed this way.

## Runtime and feature ports

For a supplied local runtime factory, wrap its actual runtime with
`registry.wrapOpeningRuntime(runtime, request.rootSessionId)`. The opening scope
is local to that asynchronous profile open. Its actual session ID is bound from
`ProfileExtensionContext.sessionManager` before extension binding; nested children
therefore retain root storage while process records identify the real creator.
Calls before that binding fail closed. Each opening also has a revocable
lifetime: draining stops new effects, admitted operations are joined, and
retained wrappers cannot restart work after disposal. Cleanup permission is
local to the draining call chain, not another root's runtime.
This is a public runtime-port wrapper,
not a private-field patch or a new profile API. The runtime factory still owns its
normal classifier/logger configuration; supplying a custom factory does not
implicitly construct those services. No environment is captured or provisioned.

`createRegistrySubagentHost` uses the real `LocalSubagentHost` with additive
lifecycle and session-factory ports. It binds the parent lifecycle, routes child
creation/restoration through `profile.openSession`, and retains the existing
nested cancellation and completion delivery behavior. The host's logical task ID
is distinct from the actual child manager ID; the additive persisted
`actualSessionId` maps them without renaming an existing Pi session. All child
storage remains rooted at the parent root ID. Child continuation reuses the
current definition prompt and inherited policy. The adapter never turns a
recovered child record into automatic execution. A resident child is bound once
across continuations; its parent-port subscription lasts until session disposal.

A live host exposes `hasActiveJobs()` independently of terminal status rows.
Shutdown aborts jobs before a fallible persistence boundary; `settle()` waits for
workers, deliveries and writes to a stable boundary and retains cleanup failures.
`hasExecutingJobs()` distinguishes active effects from queued reservations and
asynchronous opening. Policy tightening checks actual parent/root state before
dispatch and again after opening, so queued children neither bypass tightening
nor deadlock its activation. A terminal cancellation row alone is not proof
that its worker has stopped. Existing in-process callers need no new options.
When strict policy commits, the registry wakes already queued work; a separate
root blocker settling must not require another spawn to restart dispatch.
Successful cancellation also wakes queued work after its dispatch guard clears,
since an earlier policy wakeup can still encounter that guard. This cancellation
wakeup is suppressed after failure, close intent, shutdown or fencing.

S1.09 should inject the returned host and the root's shared
`registry.processes.coordinator(root, runtime)` into its existing extension
bindings. Register memory/other daemon services with `registerService`; their
settlement and disposal must cover all asynchronous workers. Their lifetime is
not an attachment's lifetime. Complete built-in execution/presenter composition
is deliberately not supplied as a pretend production fallback here.

## Resource identity

`RegistryProcesses` wraps public process, terminal and storage ports. It observes
the existing background-bash job metadata before the manager's launch effect;
that row is dispatch evidence, not executable history. No journaled command is
replayed. Live PTYs use their retained process handle; background runner control
uses the existing manager's identity checks. Restored PID/reference rows are not
signal authority. Detached runners require matching recorded identity and a
live inspection; otherwise they remain reconciling/missing and uncontrollable.
No PTY is recreated. A live detached job can block eviction without blocking
strict-policy activation. Closing/shutting down preserves those detached jobs.
The shared root coordinator resolves each PTY's creator from its registered job
identity rather than using the first runtime. Closing one child therefore stops
its own PTYs without stopping sibling processes. Process reads and coordinator
continuations participate in the same drain barrier as launches and writes.

Only references, stable identity and lifecycle state enter control resource
records. Runtime projections may show bounded command/status data, but the
control store does not acquire a second transcript or raw process environment.

## Projection

`SessionProjection` consumes actual `AgentSessionEvent` shapes and the public
Pi manager view. It coalesces tool output, commits each revision before emitting
it, and does not durably write token deltas. Active text prefixes use codepoint
offsets and become completion-only on overflow. Completed messages are backed by
stable Pi entry IDs, not copied into control persistence.

Pi emits `message_end` before its synchronous transcript append. A scheduled
refresh reads the authoritative entries after that append; it does not fabricate
a missing entry ID. Startup absence checks use **all** Pi entries, not a branch or
history page. History cursors pin session/revision/branch and reject stale views.
Model/thinking, queue IDs, catalog, tool state, presentation, interactions, child
and process views come from their actual runtime/control ports. Queue payloads
remain in memory; restart never reconstructs executable queues from their IDs.

Mandatory cancel/settle/close/eviction writes use the fixed internal safety port,
not ordinary projection capacity. Only genuine ordinary-capacity exhaustion can
defer optional reconciliation. Dirty message observations remain pending until
their reference commit succeeds, and a daemon timer retries without requiring a
new attachment. Failed storage/ownership/validation checks still fail closed.
Overflow keeps its bounded completion-only stream identity and pending notification
under the same capacity retry mechanism, before final-message reconciliation.

The server must still atomically install subscriptions with snapshot/stream
cutover and enforce per-client buffering. These modules do not claim real
socket/two-client acceptance; that remains S1.15.

## Verification scope

The S1.06 review directory records exact pinned-toolchain commands, source
snapshots, failures/fixes, final logs and protected-file hashes. Tests use only
private isolated roots, offline models, synthetic handles and a bounded
fixture-owned shell. No real user daemon/configuration/process was opened.
Executed platform: Darwin arm64. Linux S1.06 integration remains untested here;
Windows remains explicitly deferred/unsupported.
