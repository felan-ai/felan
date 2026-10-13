# Session server integration

Historical pre-services integration notes, not current API or completion
guidance. Profile bindings, pending cutover work and settings ownership below
have been superseded by [Services and UI](extension-services-and-ui.md),
[registry ownership](session-daemon-registry.md) and
[service lifecycle](session-daemon-service.md). An unavailable handler still
must reject explicitly and must not appear in negotiated capabilities.

## Admission

`OrderedAdmission` requires a server-authorized stable transport principal.
Payload origin and attachment IDs do not confer authority. It serializes the
preparation/dispatch-start boundary, not the duration of a turn. A returned
response is validated against its operation and durably committed before the
caller may publish it. Registry-managed runs commit their own dispatch intent;
the admission helper must not mark them a second time.

Duplicate requests may return their retained outcome or join an active local
request. Unowned intent and ambiguous dispatch records never execute again.
Ownership loss or a poisoned persistence handle stops admission; a failed
response write is not permission to repeat an effect.

## Fork selection

Both protocol selectors preserve the existing interactive `/fork` meaning:

- `from.kind: 'entry'` selects an entry ID from the source session's complete
  `getUserMessagesForForking()` result.
- `from.kind: 'position'` is a zero-based index into that same complete result,
  in its returned order. It is not a history-page index or an active-branch-only
  index. Empty and out-of-range selections reject.
- Resolve the selection under the source's quiescent copy claim. Open a new
  profile binding with position `before`; preserve the source's bytes, active
  branch and attachments. The new binding inherits the effective restrictions.
- Return the new session ID only. Do not resubmit the selected prompt, switch an
  attachment or replace a runtime. Restoring selected text to an editor is a
  later client workflow.

## Configuration concurrency

[ADR 0024](../decisions/0024-serialize-configuration-field-updates.md) selects
locked unconditional field merges with last-writer-wins behavior on the same
field. `config.set.expectedRevision` is obsolete and must be rejected explicitly.
Other operations retain their revision checks.

The approved target/lifetime boundaries are:

| Scope | Target and key layer | Lifetime / failure handling |
| --- | --- | --- |
| Global | Canonical `<agentDir>/settings.json`, validated extension fields and existing model defaults using the existing settings lock | Durable; surface lock/write errors; explicit reload only |
| Session | Model/thinking use their existing session operations | Transcript-backed; no global-default write. Other configuration overrides remain unavailable until their eviction/restart lifetime is approved |
| Project with session | Canonical session cwd is available, but no Felan-owned project configuration document is approved | Unavailable; do not enable ambient Pi project settings |
| Project without session | No canonical target in the current request | Reject; never infer a target from process cwd |

No configuration operation accepts environment/proxy reconfiguration, arbitrary
settings paths or credentials. A configuration read must describe the same
layer that its corresponding write would change.

The daemon-only settings entry points leave existing callers unchanged. They
bound the UTF-8 document to 1 MiB, refuse malformed/non-object data and aliased
or hard-linked targets, validate a complete update before I/O, and merge under
the existing settings lock. They recheck ownership at lock and rename boundaries,
sync the replacement and directory, and propagate failures without pretending
an uncertain post-rename write had no effect.

## Queued and handled input

`steer` and `follow_up` preserve the native input handler's disposition. A queued
input returns an accepted `{itemId}` result using its observed enqueue identity.
An input consumed by an extension returns accepted `{status: 'handled'}` without
inventing a queue entry. The two result shapes are mutually exclusive. The
native return value, not input text or the absence of a queue event, determines
whether an input was handled. Retained retries return the same accepted result
without running the handler again.

This corrects the unpublished v1 result contract to represent existing input
handler behavior. It does not add queue editing or a new execution mode. The
wider result type must be included in the public-contract release assessment;
consumers cannot assume every accepted input contains `itemId`.

## Fan-out and snapshot cutover

Each connection owns a bounded outbox. Held cutover events, queued frames and
writes still buffered by the transport all count until their write callbacks
complete. Backpressure preserves FIFO order; overflow closes only that connection
with `resync_required`, so a fresh attachment must capture a new snapshot.

Install the subscription before capturing the snapshot. Send the snapshot first,
discard events and exact text duplicates covered by its revision/prefixes, then
drain buffered post-snapshot events before entering live delivery. Reentrant
events during serialization or writing remain buffered in order. Revision gaps,
inconsistent prefixes and wrong-session events require resynchronization rather
than fabricated history. Detaching a subscription never cancels session work.

## Pending boundaries

The public-Pi spike established that observation is possible but safe atomic
queue editing lacks a public SDK boundary. The user explicitly deferred targeted
`queue.update` for Story 1; it remains unavailable and unadvertised. Existing
enqueue and faithful observation remain required, without claims of atomic edit
or selection notification. No upstream SDK change is required. No private queue
access, clearing/replay or replacement scheduler is permitted.
Actual broker arbitration belongs to S1.08; host stop/restart/logs belong to
S1.14. None may be implemented as a silently successful placeholder.

## Lifecycle and host-file boundaries

Session listing reads only registered daemon sessions. Pre-daemon transcripts are
not discovered. Explicit import creates a fresh managed identity without changing
the source; no adoption operation exists.

Deletion requires an explicit close first, removes only the identity-checked
managed transcript after a durable tombstone and never runs a trash program.
S1.11/S1.12 must display a permanent-deletion warning, not promise undo. Deleted
IDs are absent from session/child lists and cannot be restored; retained outcomes
remain available for retries.
Owned list rows expose the current revision, including for closed sessions.
Deletion clears obsolete projections and terminal outcomes expire normally;
late expired IDs still cannot replay. Deleted IDs are retired permanently. Import
can make a separate new-ID copy. Closed roots with unreconciled detached-job rows
remain conservatively busy until host lifecycle reconciliation proves their state;
deletion does not infer that an unobserved job finished.

Reload rebuilds a quiescent root through the existing profile restore path and
current service factory, retaining attachments and monotonic policy, then requests
a fresh snapshot. It does not call Pi's in-place reload or reset global providers.
Children are unavailable because generic restore cannot reproduce their injected
instructions. Any registered service currently makes the session busy, even if
its `busy()` method returns false. Reload inherits restore's headless source and
external-extension limitations; it does not require the later service split.
Session model/thinking operations never write global defaults. The later TUI
preserves interactive default selection through explicit `config.set` calls.
An interrupted but truly idle run is quiescent for cancel/reload. S1.09 must bind
the replacement subagent host through the current service factory after reload;
disposing the old host alone is not a rebind.

The daemon intentionally owns identity-checked host filesystem ports, as its
existing persistence code does. Detached output reads use only
verified retained job metadata and at most 64 KiB of positional binary I/O.
Import accepts a bounded validated external JSONL snapshot, stages it privately
and creates a new managed ID without modifying its source. Export
uses the existing SDK renderer in private staging, then atomically publishes to
an explicit destination outside every held store root; that output gains no
executable store authority. Publication durability failures after rename are
indeterminate.

Settings and export destination symlinks or hard links are deliberately refused,
even when a dotfiles setup or the old interactive UI followed them. Choose a real
single-link file instead. Import may follow a readable source symlink because it
binds and validates the opened file's identity and never writes that source.

Import validation, export destination checks, model authentication and process
availability checks run before dispatch; identity and authorization are checked
again across asynchronous boundaries. Import staging lives in an owner-private
`.felan-import` child, so an otherwise legitimate `0755` session directory works.
RPC session directories cannot select control, runtime, adopted, storage,
subagent or memory directories. This guard applies to root client requests, not
internal child storage. Internal fork/clone operations retain the source's own
session directory, as required by the existing profile ownership contract.
Copies of adopted sessions stay in the managed directory, which is excluded
from inventory scans. The RPC-root reserved-directory restriction does not apply
to these internal copies; the profile's source/destination checks remain intact.

Shell execution honors the current shell path/prefix while retaining tracked
process ownership. Context uses a sanitized rolling tail and the public Pi
truncation helper; long output has a full sanitized file in owned session storage.
Resource reads remain lossless bytes. Process listing is root-scoped; read/write/
stop separately enforce creator lineage. Completed foreground attempt guards are
reaped, while durable resource intent still rejects redispatch.

Loaded trusted skills appear as `skill:<name>` commands for TUI/headless and use
native explicit skill expansion when `getEnableSkillCommands()` permits it.
ACP prompt expansion remains disabled. Typed
extension/skill invocation is currently idle-only; S1.09/S1.11 must preserve that
restriction unless a separate safe effect boundary is designed.

List paging uses scope-bound keysets; unrelated commits do not invalidate a
cursor. Label edits intentionally require a resnapshot because the wire has no
label-delta event. The committed outcome is queued to the requester before its
write-completion callback triggers invalidation. A failed transport can still
require retained-outcome retry. Admission pruning may independently require an
immediate resnapshot before a reply; this conservative trade-off remains explicit.

Full shell-output logs currently persist until their owned session storage is
explicitly removed; deleting only the transcript does not remove them. Automatic
retention/cleanup is deferred to host lifecycle work so it cannot invalidate live
byte readers silently. Operators must account for that disk usage.

A missing keyset anchor still requires a resnapshot rather than silently skipping
to a greater key. After transcript deletion, repeat the original request ID to
retrieve its retained outcome; tombstoned rows are not listed with a new revision.
New-ID cleanup retries require a future explicit host-management path.
