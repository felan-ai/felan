# Connector contract change requests

This records clarifications and proposed changes to the Story 2 connector
contract, draft 2026-10-15, at
`../felan-platform/docs/architecture/shared-session-daemon/connector-contract.html`
(path relative to the repository root). It is not a replacement contract.
The implementation follows the contract as written; unresolved points and the
current interpretation are recorded below rather than silently changing the wire
format. The **Platform decision** lines quote the essence of the contract's
2026-10-18 decisions (`daemon-cr-1`–`daemon-cr-23`); the requests retain their
original context.
CR 24 records a user-requested implementation ahead of the platform's decision
and asks to amend the accepted CR 9/CR 10 extension wording.

`packages/session-protocol/src/publication.ts` and `OriginSchema` were not changed
for the Story 2 connector implementation. The platform pins `@felan-ai/session-protocol`
`0.1.0-next.0` exactly (`0.3.0-next.0` was published in error). Changes to those
shared schemas require a new package release and coordinated platform adoption.
The Story 3 answers at the end of this document change both schemas in
`@felan-ai/session-protocol` 0.2.0.

## 1. RPC error encoding

**What:** The contract names RPC failures but does not define their wire encoding.
The platform migrations use SQLSTATE `PTxxx`, a machine code in `MESSAGE`, and
JSON in `DETAIL` when additional data is needed.

**Why:** The connector must distinguish retryable failures, revoked authority,
terminal sessions, sequence recovery and rejected command completions without
depending on human-readable error text. `conflict` and `limit_exceeded` are not
named in the draft.

**Proposed change:** Document the PostgREST error fields as `code` = SQLSTATE,
`message` = machine code, and `details` = JSON-encoded `DETAIL`, with this mapping:

| SQLSTATE | `MESSAGE` | `DETAIL` |
| --- | --- | --- |
| `PT400` | `invalid_request` | None required |
| `PT403` | `not_a_host`, `host_revoked`, `not_a_member`, `forbidden` | None required |
| `PT409` | `sequence_gap` | `{"lastSeq": n}` |
| `PT409` | `conflict` | None required; command is no longer claimed, except an identical completed outcome remains idempotent |
| `PT410` | `session_deleted` | None required |
| `PT413` | `limit_exceeded` | None required |
| `PT426` | `unsupported_schema` | `{"supported": [versions]}` for supported row schema versions |

**Proposed change (classification):** State that hosts honour these meanings
only when `code` matches `PT` followed by three digits and `message` is exactly
the machine code, and that structured data is read only from JSON `DETAIL`.
For publication, non-platform HTTP 400/404/413/422 and PostgreSQL data/constraint
errors (`22xxx`, `23502`, `23514`) or PostgREST request errors (`PGRST1xx`)
quarantine only that session as `invalid`, never terminal, preserving its outbox.
HTTP 408/429/5xx and network failures retry with connection-level backoff.
Non-platform 401/403 responses trigger token re-exchange. After a successful
exchange, another non-platform 403 for the same session quarantines it until
restart rather than reconnecting indefinitely; a successful publish clears this
bounded-retry guard.

**Platform decision:** Accept — “the `PTxxx` → message → `details` table and the host's classification rules.”

**Current implementation:** `parsePlatformError` in `remote/platform.ts` parses
terminal session meaning only from exact typed machine errors and reads details
only from JSON. The publish RPC uses the classification above. Claim, completion,
registration and heartbeat retain their existing non-platform classification:
their deterministic errors do not identify a poisoned session publication, so
this change does not reinterpret them. A rejected typed completion payload still
gets one minimal non-retryable `unavailable` fallback. Non-retryable publication
failures appear in `/remote status` without dropping the outbox or stopping claims.

## 2. Marker for an unshared interval

**What:** The off → on open question suggests a marker when an interval is not
uploaded, but no such change type exists in `PUBLISHED_CHANGE_TYPES`.

**Why:** Uploading the interval defeats the user's decision to stop sharing;
silently omitting it can make the web transcript look complete.

**Proposed change:** Define an additive publication marker for “not shared during
this interval,” including enough boundary information for display. Add it to the
shared schema and publish set in a new release. Do not upload the omitted content.

**Platform decision:** Defer — “One omission marker covers 2, 5 and 18”; requires a protocol release and the platform `publish_session_events` allow-list before hosts send it.

**Current implementation:** After a session has been uploaded, changes made
while sharing is off are not recorded for publication. Turning sharing on again
does not backfill that gap and sends no gap marker. First-time sharing still
backfills local history. Turning off before any upload attempt discards the unpublished
outbox without sending even an index row; a later first share backfills afresh.
Upload intent and the host ID are persisted before sending the first request.
An unacknowledged upload may already exist remotely: turning it off still sends
`shared: false` and retains sequence continuity on re-enable or restart.
See `remote/connector.ts` and `remote/sharing.ts`.

## 3. Web-created sessions cannot turn sharing off

**What:** “Always shared” does not explicitly say whether `/remote off` is refused
for a session created from the web.

**Why:** Otherwise the host setting and per-session command appear to contradict
the web-creation rule.

**Proposed change:** State that web-created sessions remain shared while the
connector is configured and authorized, and that per-session attempts to turn
sharing off are rejected. Logging out still stops the connector.

**Platform decision:** Accept — “Web-created sessions remain shared while the connector is configured and authorized”; logout still stops it.

**Current implementation:** `remote/sharing.ts` rejects disabling a web-created
root. Its children follow the same root decision. `session.remote` returns
`forbidden`; it does not silently ignore the request.

## 4. Explicit session opt-out overrides `share: all`

**What:** The precedence of `/remote off` and the host's `share: all` setting is
not stated.

**Why:** “All shares every session” could accidentally override an explicit
privacy choice, including after restart or a later host-setting change.

**Proposed change:** Specify that explicit per-root-session sharing choices take
precedence over the host default, except for always-shared web-created sessions.
Children inherit their root's choice.

**Platform decision:** Accept — explicit opt-out wins; “Children follow their root session.”

**Current implementation:** `remote/sharing.ts` and `remote/state.ts` persist an
explicit opt-out. Changing the host default to `all` does not override it.

## 5. Changes that cannot fit within 1 MiB

**What:** The contract limits each change to 1 MiB without defining what happens
when valid non-text structure alone exceeds that limit.

**Why:** Removing inline images and shortening text cannot reduce arbitrary
arrays or object structure to a schema-valid, meaningful change.

**Proposed change:** Specify a deterministic reduction policy or a new omission
marker, including which fields may be shortened or omitted and how readers show
the loss. Any marker needs a shared-schema release.

**Platform decision:** Defer — “Same marker as 2”; requires a protocol release and platform allow-list; meanwhile skip without a sequence number.

**Current implementation:** `remote/content.ts` redacts content, replaces inline
images with `[image omitted]`, caps tool output, and shortens eligible text while
preserving schema constraints. If the change still exceeds 1 MiB, the connector
skips only that change, without allocating a sequence number, and continues
recording. A persistent per-session count appears in `/remote status` as
“N changes could not be published.” It does not invent an omission event.

## 6. `interrupted` run state

**What:** The Tables section lists `idle | running | waiting | cancelling`, but
`PublishedSessionSchema` also includes `interrupted`.

**Why:** Recovered or interrupted local runs must remain representable without
an undocumented conversion to `idle`.

**Proposed change:** Add `interrupted` to the documented `host_sessions.run_state`
values and keep the table constraint aligned with the published schema.

**Platform decision:** Accept — “Already implemented (CR-1).”

**Current implementation:** `remote/content.ts` publishes the actual run state
through `parsePublishedSession`, including `interrupted`. No schema change is
needed in Felan for this clarification.

## 7. Operation-specific command outcomes

**What:** `RemoteCommandOutcomeSchema` reuses the generic `ResponseSchema` union.
`parseRemoteCommandOutcome` normalizes accepted results such as `{ session }` and
`{ runId }` to `{}` through the union's empty-result branch.

**Why:** Parsing an otherwise accepted outcome loses the identifier needed to
open a created session or correlate a run.

**Proposed change:** Define operation-specific remote outcome schemas and a
parser that uses the command operation to select its result schema. Release the
changed session-protocol package before platform adoption.

**Platform decision:** Amend — “No package change”; validate the outcome, then parse its stored result with `parseOperationResult(op, result)`.

**Current implementation:** `remote/commands.ts`, `remote/command-journal.ts` and
`remote/platform.ts` validate outcomes but preserve the original accepted result
when journaling, replaying and sending it. They do not send the normalized `{}`.

## 8. Remote create result naming

**What:** The original remote command draft returned `{ session }` from
`sessions.create`; the local protocol's `ResultSchemas['sessions.create']`
returns `{ sessionId }`.

**Why:** “Outcomes reuse the protocol” does not explain this adapter-level rename.

**Proposed change:** Explicitly document the remote `{ session }` result and its
mapping from local `{ sessionId }`, or agree on one name and release the shared
schema before changing consumers.

**Platform decision:** Amend — “One name, `{ sessionId }`”; the daemon and web use the existing package result, with no package release.

**Current implementation:** `remote/commands.ts` reads the local `sessionId`,
marks the session web-created, and returns `{ sessionId }` on successful remote
creation, as the amended contract requires.

## 9. Web creation provenance versus client kind

**What:** `ClientKindSchema` contains `tui | acp | headless`, not `web`.
`OriginSchema` separately supports `{ kind: 'web', user, command }`.

**Why:** A web origin should not imply that interactive local extensions are
loaded, or that a new client kind already exists.

**Proposed change:** Confirm `headless` as the creation source with web run/queue
provenance, or define a distinct web creation source in a new protocol release.
Specify its extension-loading behavior.

**Platform decision:** Accept — “No new client kind and no interactive extensions”; headless creation retains web run/queue provenance.

**Current implementation:** Remote create records no creation source and uses
the host's external-extension settings. It never prompts: project extensions
load only for folders already trusted locally, directly or through a parent.
Explicit extension paths are refused. The daemon admits remote work with the
existing web run/queue origin; `hello` client kinds and `OriginSchema` are
unchanged. See `remote/commands.ts`, `daemon/server.ts` and CR 24, which requests
an amendment to the accepted extension wording.

## 10. Owner answers and opened-project trust

**What:** The contract excludes `local-console` answers but leaves remote
`authority: 'owner'` answers and unattended project trust implicit.

**Why:** These are authorization decisions, not presentation details. A laptop
must not unexpectedly need a local trust dialog to complete an admitted remote
create, nor treat every directory as remotely approved.

**Proposed change:** Confirm that the authenticated paired owner may answer
session-scoped owner-authority interactions, never host-scoped or
`local-console` interactions. Define an explicitly opened project as a standing,
non-interactive grant to create headless sessions in that directory until it is
closed. It is not a grant to arbitrary paths or interactive extensions.

**Platform decision:** Accept — “An opened project is a standing grant for headless sessions”; host-scoped and `local-console` answers remain forbidden.

**Current implementation:** `daemon/broker.ts` allows remote owner answers subject
to interaction-kind, scope, expiry, answer validation and first-answer rules; it
rejects host-scoped and `local-console` answers. `remote/commands.ts` resolves only
opened project IDs. Remote root preparation applies the host's external-extension
settings without a prompt, loads project extensions only for folders already
trusted locally, and refuses explicit extension paths. Opening a project grants
neither folder trust nor permission to supply extension paths. See CR 24 for
the requested amendment to the accepted wording.

## 11. Partial create when the initial prompt fails

**What:** Remote creation with an initial prompt comprises two local operations.
The contract does not define an outcome when creation succeeds but the prompt
fails.

**Why:** A rejected command can leave a real shared session behind, and the
caller needs to know whether retrying would create another one.

**Proposed change:** Define a partial-success result that identifies the created
session and the prompt failure, without retrying creation implicitly. Coordinate
its schema in a new release.

**Platform decision:** Defer — “a failed initial prompt is a rejected outcome without the session ID”; the created session still appears in the host's list.

**Current implementation:** `remote/commands.ts` marks the created session shared
before submitting the initial prompt. The session remains if the prompt fails;
the remote outcome is that prompt failure without the session ID. The journal
protects the original command from duplicate execution.

## 12. Re-pairing and retained outboxes

**What:** A new pairing of a different machine creates a new host and “never inherits upload authority or
history,” but the fate of old local outboxes is not explicit.

**Why:** Keeping an outbox after `invalid_pat` is not a promise that a new pairing can
upload it. The old host still owns its published sessions.

**Proposed change:** State that previously published sessions cannot be continued
by the new host: they are read-only/terminal from that host's perspective, and
their local outboxes are dropped. Retained entries for an old pairing can resume
only if the same machine re-pairs and the platform still authorizes that pairing.

**Platform decision:** Accept — “Previously published sessions cannot be continued by the new host”; old-pairing outboxes are dropped.

**Current implementation:** `remote/connector.ts` persists the publishing host ID.
On reconnect with a different host, it marks those sessions terminal `forbidden`,
drops their outboxes and reports them in `/remote status`. This does not delete
the old platform history or the local sessions. Outboxes are kept while stopped
on `invalid_pat`; re-pairing the same machine restores the same host and resumes them; once a different machine pairs as a new host, the old host's
outboxes are dropped. A new pairing cannot inherit them.

## 13. Unrecoverable `sequence_gap`

**What:** The contract returns platform `last_seq` on a gap but does not define
recovery when it lies outside the connector's local
`[acked, highest appended]` range.

**Why:** A platform restore or lost local outbox can make safe replay impossible.
Inventing sequences or resetting them could corrupt the published history.

**Proposed change:** Require the connector to stop publication for that session,
preserve available evidence and report an explicit recovery failure. Define a
separate authorized reconciliation or replacement-session procedure; do not
silently reset sequence numbers.

**Platform decision:** Accept — “Publication for that session stops and the evidence is kept”; nothing is renumbered beyond CR22.

**Current implementation:** `remote/connector.ts` acknowledges the platform's
already-stored prefix when the returned sequence is within the local range and
advances recovery. Ahead-of-range recovery now fast-forwards pending entries as
described in CR22, the only renumbering exception. Unrecoverable or non-advancing
sequences still block the session, preserve the outbox and appear in
`/remote status`; other sessions can continue.

## 14. Claimed command wire shape

**What:** `claim_session_commands` returns raw `session_commands` rows, whereas
`RemoteCommandRowSchema` describes
`{ id, host, requester, command, createdAt, expiresAt }`.

**Why:** The database has snake_case columns, separate `op`/`params`, and timestamp
strings. The protocol schema is not a direct parser for those rows.

**Proposed change:** Specify the raw RPC result and its mapping: `host_id` →
`host`, `requester_user_id` → `requester`, `op`/`params`/`session_id` → `command`,
and `created_at`/`expires_at` → epoch milliseconds. State that `session_id` is
null for create, and document the returned state and any other database fields.
Alternatively introduce an RPC DTO in a coordinated change.

**Platform decision:** Accept — “raw `session_commands` rows and their mapping to `RemoteCommandRow`”; no separate DTO.

**Current implementation:** `remote/platform.ts` maps and validates raw rows
before dispatch. A malformed row is isolated from other claims; a valid command
ID allows a rejected outcome rather than execution.

## 15. Full opened-project paths

**What:** `HostProject.path` carries a full local directory in `host_register`,
while `host_sessions.directory` deliberately carries only the last path segment.

**Why:** Registering an opened project discloses more filesystem information than
publishing a session label. Users need to understand the exception.

**Proposed change:** Confirm that the full opened-project path is intentional and
document its privacy implications, or replace it with a name-only registration
while retaining ID-to-path resolution locally in a new shared-schema release.

**Platform decision:** Accept — “`hosts.projects` is readable only by the host's owner”; the web sends only project IDs.

**Current implementation:** `remote/state.ts` canonicalizes opened directories;
`remote/connector.ts` registers their full paths. `remote/content.ts` publishes
only the basename as the session directory label. Paths appearing inside user
messages or tool output are not generally removed by credential redaction.

## 16. Local machine-credential and service-role test fixtures

**What:** The contract requires tests against local Supabase without documenting
how to obtain a local machine credential or privileged fixture access.

**Why:** A hash convention or signing-key mismatch can look like a connector
failure. Contributors must not use production credentials or start another stack.

**Proposed change:** Document the local fixture path, prerequisite migrated stack
and shared signing key, and the credential storage convention: SHA-256 of the complete
`fln_pat_...` token encoded as lowercase hex in `api_keys.key_hash`, with
`scope = 'personal'`, `user_id`, `team_id`, and `encrypted_key = null`. Explain
how a developer obtains a machine credential: by pairing through `/remote login` and approving in the browser, or through disposable test fixtures.

**Platform decision:** Accept — “a local test environment section”: browser pairing through `/remote login`, signing key and `key_hash` convention.

**Current implementation:**
`apps/daemon/test/support/remote-supabase.ts` creates disposable owners, teams,
machine-credential hashes and hosts. It reads the local platform's
`supabase/signing_keys.json` and signs a short-lived service-role token for
fixture setup/cleanup; it does not require a production service key or persist
the plaintext credential. RPC tests use scoped host tokens. The integration suite never
starts Supabase. Commands and prerequisites are in
[the connector guide](remote-connector.md#local-development-and-testing).

## 17. Token endpoint

**What:** Comparison of the platform's `POST /api/v1/hosts/token` route
(`apps/web/app/api/v1/hosts/token/route.ts` in felan-platform) with the contract
and `remote/token.ts`. No change is requested.

**Why:** Recorded so the comparison is not repeated and so a later divergence is
visible.

**Proposed change:** None. Path, Bearer machine credential, request body (`installId`, name byte
limit, `daemonVersion`, `protocol`, `rowSchemaVersion`), response body (`token`,
`expiresAt`, `refreshAt`, `host`, `supabase`), status codes (400, 401, 403, 426, 429,
5xx), the flat error body `{ code, message, supported? }`, and the ES256 claims
(issuer, audience, role, host subject, `felan` claims, lifetime of at most 900
seconds) all match the contract.

**Platform decision:** No change — “Comparison only.”

**Current implementation:** `remote/token.ts` requires no contract change. The
endpoint tests in `remote-supabase.integration.test.ts` cover exchange with a
personal machine credential, stable host ID for the same credential and install ID, and 401 `invalid_pat`
for a revoked credential; they skip when the local API is unavailable. Unknown token
error codes remain retryable (see platform CR-9 below).

## 18. Publication quarantine lifetime

**What:** The contract does not say how long a host keeps retrying a session
whose upload fails with a non-retryable error (`invalid_request`,
`limit_exceeded`, or a `sequence_gap` the host cannot recover), or whether the
host keeps recording that session's changes in the meantime.

**Why:** Retrying immediately loops on the same rejection. Never retrying loses
the web copy for good, and not recording while blocked leaves a permanent hole
after the cause is fixed.

**Proposed change:** Distinguish publication quarantine from local recording
failure. Quarantine only the affected session's uploads, keep recording within
a bounded outbox, and retry after a daemon restart (or an update that fixes the
cause). Define an additive omission/resynchronization marker for content that
was never recorded because local storage failed or the pending cap was reached.
The web must not imply that an append-only copy with such a hole is complete.
Any marker or resynchronization procedure needs coordinated schema support.

**Platform decision:** Accept — “Quarantine is per session”; recording remains bounded and uploads retry after restart/update; the marker is deferred with CR2 pending a protocol release and platform allow-list.

**Current implementation:** Uploads for the affected session stop until the
daemon restarts; other sessions and commands continue, and `/remote status`
lists the blocked session. Local recording continues during the quarantine, so
the backlog uploads contiguously after a restart, unless the 64 MiB per-session
or 256 MiB total pending-byte cap is reached or local storage fails. A cap stops
recording for the affected session while its existing backlog can drain. A
storage/integrity failure instead blocks recording and publication for the
unreadable/fenced outbox until restart; a shared-directory commit fence can block
all outboxes. Durable files are retained, not promised to drain while storage is
unavailable. Unaffected sessions and command claims continue without reconnect
loops; status reports failures and warns when counts are stale. Uncertain writes
must be reopened and recovered before use. Recording resumes after restart, but
changes during the block are not recovered. The append-only web copy has no
resynchronization or omission marker today. Unrepresentable individual changes
are skipped and counted instead (CR5). A non-storage snapshot/backfill failure
leaves the session not-backfilled and retries on later publishable changes or
residency, at most once per second; live changes wait for the successful snapshot
rather than starting an incomplete chronological copy.

Deleting a session locally discards its outbox only if no upload was ever
attempted. Otherwise its record and sequence remain until `shared: false` is
acknowledged; then the outbox is dropped and the record removed. History remains
on the platform read-only; no remote delete API is called. Terminal records are
removed immediately, including dropped zero cursors with no host ID.

## 19. Stale claimed commands

**What:** `claim_session_commands` returns rows this host claimed earlier but
never completed, whatever their `expires_at`. The contract says such rows are
answered from the daemon's request records, but a host can crash or drain
after the claim and before it records anything.

**Why:** Without a record, a command claimed before a crash would run when the
daemon next starts, possibly days later and long after the requester stopped
waiting.

**Proposed change:** State that a host completes a previously claimed row that
has no local record and whose `expires_at` has passed as `rejected` with error
code `expired`, and never dispatches it. Rows with a local record are answered
from it (the recorded outcome or `indeterminate`) regardless of expiry.

**Platform decision:** Accept — “a rejected outcome with code `expired`” displays as “Not delivered”; claim server time remains open.

**Current implementation:** The claim RPC returns `claimed_at` (the migration
uses `RETURNING *` and includes earlier claimed rows). `remote/platform.ts` maps
it to epoch milliseconds. The connector captures the call start and one return
time per batch. `RemoteCommandExecutor` considers a row freshly claimed when
`claimed_at >= callStart - 5 s`; the database already checked its expiry, even if
the RPC or earlier commands were slow. For older rows, or rows lacking a claim
timestamp, only `expiresAt <= batchReturn - 5 s` is expired. This tolerates small
clock skew and avoids reevaluating expiry during sequential execution. Older
unjournaled expired rows return `rejected`, code `expired`, message
`Remote command expired before admission.`, `retryable: false`. Journaled rows
follow normal recovery regardless of expiry. Large host/database clock skew
cannot be disambiguated reliably without an explicit freshly-claimed flag or
server time in the RPC; a coordinated contract addition would remove that limit.

## 20. Requester must be the host owner

**What:** The Felan API authorizes commands before inserting them, but the
contract also says "a row is never admission by itself". It does not say
whether the daemon must check who requested a command.

**Why:** Platform authorization should not be the only guard for actions on a
user's machine. Nothing in the `session_commands` schema ties
`requester_user_id` to the host's owner.

**Proposed change:** State that a host rejects any command whose requester is
not the user its host token was issued for (`felan.user_id`), before admission.

**Platform decision:** Accept — “A host rejects any command whose requester is not the user its host token was issued for”, before admission.

**Current implementation:** The connector passes the current token's
`host.userId` to `RemoteCommandExecutor`, which completes commands from any
other requester, or while the owner is unknown, as `rejected` with `forbidden`
without dispatching them.

## 21. Crash guarantees under `synchronous=NORMAL`

**What:** The claim contract says a crash between claim and completion returns
the recorded outcome or `indeterminate`, never a second run, without qualifying
the kind of crash or the control store's durability.

**Why:** The daemon's shared SQLite control store uses
`synchronous=NORMAL` ([ADR 0042](../decisions/0042-use-normal-synchronous-control-store-commits.md)).
Committed transactions survive a daemon or process crash, but an OS crash or
power loss can roll back recent committed admission and command-journal rows.

**Proposed change:** Qualify the recorded-outcome-or-`indeterminate` guarantee
as applying to daemon or process crashes. State that, after an OS crash or power
loss under NORMAL durability, a lost journal/admission row can cause the same
command ID to be admitted and run again, just as local request deduplication can.
This is not exactly-once execution across loss of committed state.

**Platform decision:** Accept — “covers daemon and process crashes only”; no exactly-once promise after OS crash or power loss.

**Current implementation:** Remote records use the daemon's shared control
database. A surviving journal replays its outcome or recovers dispatch as
`indeterminate`. Full-database recovery completes unjournaled claims as
`indeterminate` until an empty successful claim response persists the per-host
`command_recovery` marker. An ordinary NORMAL rollback with a lost journal cannot
establish prior admission and permits the command to run again.

## 22. Fast-forward after restored publication-sequence rollback

**What:** CR13 treats a platform `last_seq` outside the local cursor range as
unrecoverable and blocks the session. It does not cover a local outbox or next
sequence rolled back by an OS crash or power loss after the platform accepted a
later publication.

**Why:** Retaining an append-only sequence after local NORMAL-durability loss
should not permanently block a session merely because the platform has a
higher, already-published sequence.

**Proposed change:** Permit the connector to make an optional inexpensive
`last_seq` read on connect and, on the first platform sequence gap in a recovery
chain, fast-forward past that value by renumbering all still-pending entries,
including buffered entries. Permit only one fast-forward across fair scheduling
passes; clear that recovery chain after a successful publication or when pending
data is exhausted. A repeated gap or a second `last_seq` ahead of the outbox
remains inconsistent and blocks the session. Document the resulting eventual
consistency: around OS crash or power loss, a few web-visible changes can be
duplicated, missing or out of order.

**Platform decision:** Accept — “without the connect-time read”; publish returns and `sequence_gap` details carry `last_seq`; eventual-consistency caveats are accepted.

**Current implementation:** `remote/connector.ts` and `remote/platform.ts` do
not read `last_seq` on connect. The publish acknowledgement or gap detail drives
recovery. `RemoteOutbox.fastForward` renumbers all pending entries, including
buffered entries, above the first recovered ahead-of-outbox sequence. The
connector permits only one fast-forward per recovery chain and blocks repeated
or otherwise inconsistent responses. Success or exhausted pending data clears
the chain. The platform skips sequences at or below its `last_seq` without
comparing content; after OS crash or power loss the web copy can have duplicated,
missing or out-of-order changes.

## 23. Viewer presence and bounded late-join text replay

**What:** The contract defines private Broadcast text on `session:<id>` but not
browser viewer presence or what a late viewer receives from the current stream.

**Why:** Without presence, a host cannot avoid live-text Broadcast cost when no
one is viewing a session. A viewer joining mid-stream otherwise sees no current
text until later chunks arrive or the stored completion is published.

**Proposed change:** Define authorized Realtime presence for browser viewers on
`session:<id>`, including a host-observable join/leave count. Let the host omit
live text while no viewer is present. When a viewer joins, let it replay a
bounded current-stream prefix as existing text Broadcast events, preserving the
live-text contract's 32 KiB chunk maximum and four-sends-per-second limit. This
does not change `TextStreamEvent`, its broadcast-only nature or stored-completion
behavior.

**Platform decision:** Accept — “Accept with conditions”; presence gating and replay remain optional daemon work after platform policies are in place.

**Current implementation:** Optional, **not implemented**. The connector has no
viewer-presence signal and no late-viewer stream-prefix replay; it only applies
the existing 32 KiB chunk and four-sends-per-second-per-stream limits. Any future
presence/replay implementation must obey all accepted conditions:

- Only the session owner's browser tracks presence on `session:<id>`, with a
  random per-page key, empty payload and only while the page is visible.
- The owning host only receives presence. Neither browser nor host uses
  presence on `host:<id>`.
- The host may omit live text when nobody is present. On viewer join, replay
  the current stream from offset 0, at most 32 KiB per chunk, four sends per
  second per stream and 64 KiB per second per session.

## 24. Host-configured external extensions for web-created sessions

**What:** Amend the accepted CR 9/CR 10 wording, including “no interactive
extensions” and “not a grant to … interactive extensions,” to distinguish
host-configured external extensions from permissions granted by the web.

**Why:** External extensions are a per-host choice, not a per-session or
per-client choice. The same settings should apply to roots created by the TUI,
ACP, headless runs, the web and `session.import`. Opening a project for remote
creation must not implicitly trust its extensions or cause an unattended
folder-trust prompt.

**Proposed change:** Web-created roots use the existing host settings
`piExtensions.user` and `piExtensions.project`, both off by default. They never
prompt; project extensions load only for folders already trusted locally,
directly or through a parent. Undecided folders are skipped without saving a
decision. Remote creates cannot supply explicit extension paths. No creation
source is recorded, and neither `hello` client kinds nor `OriginSchema` change;
web run/queue provenance remains `{ kind: 'web', user, command }`. Children
inherit the root's external extension paths, with worker tool allowlists still
limiting active tools. Paths remain fixed at creation; resume and clone/fork
retain saved paths.

**Platform decision:** Pending; this requests an amendment, not a previously
accepted platform change.

**Current implementation:** At the user's request, the daemon implements this
policy ahead of the platform's decision. Remote creates use host-driven root
preparation without a local prompt or explicit paths. Children load the root's
external extensions. This code runs with the user's permissions in web-created
and child sessions as well as other session modes. The separate built-in
`piExtensions.llamaCpp` integration remains root-only and is unchanged.
See [ADR 0043](../decisions/0043-apply-external-extension-settings-per-host.md).

## 25. Loaded skills and background processes on the session row

**What:** The web session side panel needs a session's loaded skills and its
background processes. `catalog.updated` and `process.updated` are not in
`PUBLISHED_CHANGE_TYPES`, and the web replays only a recent page of events, so a
catalog sent at session start would be lost in long sessions.

**Why:** The current value belongs on the `host_sessions` row, the same way the
title and run state are published.

**Proposed change:** `PublishedSessionSchema` gains two optional arrays, each at
most `LIMITS.pageEntries` (256) items:

- `skills`: `{ name, description, path, scope }`. `name` is at most 128 bytes,
  `description` 1024 bytes and `path` 1 to 512 bytes. `scope` is `project`, `user`
  or `temporary`. `path` is the skill file relative to the session directory
  (`.agents/skills/x/SKILL.md`), relative to the host account's home with a `~/`
  prefix (`~/.agents/skills/x/SKILL.md`), or otherwise only `<skill directory>/SKILL.md`.
  `parsePublishedSession` rejects paths that start with `/`, `\` or a drive letter.
- `processes`: `{ id, command, kind, state, startedAt, exitCode? }`. `command` is at
  most 1024 bytes, `kind` is `foreground`, `detached` or `pty`, and `state` is
  `running`, `exited`, `missing` or `interrupted`. `exitCode` is present only when
  the host knows it. Output, offsets and controls are never published.

An absent array means the host does not know the current value, so the platform
should keep the stored column. An empty array means there are none. Store each
array as a bounded JSON column, for example `skills jsonb` and `processes jsonb`,
updated only when the key is present. `ROW_SCHEMA_VERSION` stays 1:
`publish_session_events` already ignores unknown `p_session` keys, so daemons can
send the fields before the migration lands.

**Platform decision:** Agreed in the session side panel design (BUG-431,
BUG-446); the migration and tabs are platform work.

**Current implementation:** `remote/content.ts` builds both arrays.

- Skills are every skill the session's resource loader loaded. This includes
  skills without an available `skill:` command.
- Processes are only those owned by the row's session, running first and then
  the most recently started.
- Descriptions and commands are redacted like titles.

The connector treats `catalog.updated` and `process.updated` as row-only changes
for shared, backfilled sessions. It republishes the row with `p_events: []` when
the sanitized arrays differ from the last acknowledged ones. A change to process
output alone does not republish. Every other row publication carries the current
arrays too. `skills` is omitted while a session is not loaded in the daemon;
`processes` is always sent for shared sessions. Unshared rows carry neither.

Untitled subagent sessions (BUG-447) take the description their parent supplied.
The daemon writes it as the child's Pi session name when it creates the child, so
the published row title, `child.updated` and the session header all carry it.
Existing and user-set titles are unchanged. No published data links a child to
the spawning tool call, so sessions created before this change keep an empty
title; they are not backfilled.

## 26. Root session task graph on shared session rows

**What:** Publish the current root-session task graph in the optional `tasks` field of each shared `PublishedSession` row. `ROW_SCHEMA_VERSION` remains 1. Each task contains only `id`, `title`, `status` and `blockedBy`; titles are at most 200 characters. The array accepts at most 256 entries and each task has at most 32 prerequisite IDs. Supported statuses are `pending`, `in_progress`, `blocked`, `completed` and `cancelled`.

**Why:** The web Tasks tab needs the graph's current state for the root session and all its subagent views, without replaying task history as session events.

**Source and update:** `ext-tasks` reports the root-shared store's task snapshot through the Agent Runtime task-change hook after successful mutations and when a session loads or resumes. The daemon owns the hook boundary and publishes the resulting root snapshot on every shared row in that session tree. `tasks.updated` is a row-refresh signal only; it is not a published event. Changes republish affected rows with `p_events: []`, without waiting for another session event.

**Meaning and privacy:** An absent `tasks` field means the host does not know the
graph and leaves the stored value unchanged. An empty array means the graph has
no tasks. Unshared rows never carry the field. CR 27 adds owners and timestamps
on the row, and descriptions, acceptance criteria, notes, results and blocked
reasons through `publish_session_tasks`. No task edit operation is added to the
remote protocol.

**Platform work:** Add a `tasks jsonb` column to `host_sessions` and update `publish_session_events` to validate the bounded task shape, preserve the column when the key is absent, clear it for unshared sessions, and issue the existing row realtime hint when the value changes. No session-event replay or row-schema bump is needed.

## 27. Task details for shared sessions

**What:** Add short task metadata to each shared row's `tasks` summary and
publish full task text separately through `publish_session_tasks`.

**Why:** Linear BUG-462 needs descriptions, acceptance criteria, an Activity
section with notes, results and blocked reasons, and chips for priority, owner
and lifecycle dates. A single row cannot carry full details. 200 tasks with all
detail fields at their byte limits need 20.8 million bytes, above the 4 MiB
`publish_session_events` limit. After each task change, the daemon republishes
the graph on every shared row in the session tree.

**Proposed change:** `PublishedTaskSchema` keeps `id`, `title`, `status` and
`blockedBy` and adds these optional fields so older hosts can omit them:

- `priority`: an integer from 0 to 4, with 0 highest and 4 lowest.
- `ownerSessionId`: an `IdSchema` value for the session that claimed the task,
  present only while the task is `in_progress`.
- `createdAt`, `updatedAt`, `claimedAt`, `completedAt`: non-negative safe
  integers in epoch milliseconds, matching `PublishedProcessSchema.startedAt`
  and session `lastActivity`. `claimedAt` is present only while `in_progress`;
  `completedAt` is present only when `completed`.

`ROW_SCHEMA_VERSION` stays 1. The summary still allows at most 256 tasks, titles
of at most 200 characters and 800 bytes, and at most 32 prerequisites per task.

`PublishedTaskDetailSchema` requires `id` using `IdSchema` and allows these
optional, nonempty text fields. `PUBLISHED_TASK_TEXT_BYTES` sets their UTF-8
byte limits, with no character limit. These byte limits are four times the
`TaskCreate` and `TaskUpdate` tool character limits. UTF-8 bytes give hosts and
both validators the same unit. TypeBox counts graphemes for character limits,
while Postgres `char_length` counts code points.

| Field | UTF-8 bytes |
| --- | --- |
| `description` | 16,000 |
| `acceptanceCriteria` | 16,000 |
| `notes` | 32,000 |
| `result` | 32,000 |
| `blockedReason` | 8,000 |

`PublishedTaskDetailsSchema` contains `session`, the root session UUID, and
`tasks`, an array of 1 to 256 detail records. `parsePublishedTaskDetails`
rejects duplicate task IDs and requests whose UTF-8 encoding of
`JSON.stringify({ p_session: session, p_tasks: tasks })` exceeds
`PUBLICATION_LIMITS.batchBytes`, 4 MiB. The RPC
`publish_session_tasks(p_session uuid, p_tasks json)` returns nothing. The host
sends `{ p_session: details.session, p_tasks: details.tasks }`.

Each detail record fully replaces the stored detail for its session and task
ID. An absent field means no current value, so omitting `blockedReason` clears
the old blocker. The root row's `tasks` array determines membership and order;
details for IDs outside it are stale. Child rows carry the same task summary,
but the platform stores details once under the root. The web finds that root by
following `parent` up the row chain.

**Meaning and privacy:** Task text uses the same credential and secret-named-key
redaction as other published content. For shared sessions, this text already
reaches the platform through published history, in `TaskCreate` and `TaskUpdate`
`tool_call` arguments and tool result `details`. Withholding it from the row did
not keep it private.

**Platform work:** The separate platform repository must implement these steps:

1. Add `host_session_tasks`, keyed by `session_id` and `task_id`, with nullable
   `description`, `acceptance_criteria`, `notes`, `result`, `blocked_reason` and
   `updated_at` columns. Set `updated_at` to the platform's write time for the
   detail record, not the task's lifecycle `updatedAt`. Give it team read access
   like `host_sessions` and cascade deletion with the session row.
2. Add `publish_session_tasks(p_session uuid, p_tasks json)`. Require the host
   caller to own the shared, non-tombstoned row, with `PT410 session_deleted`
   and `PT403 forbidden` errors. Reject `p_session` with `PT400
   invalid_request` if its row has a `parent`; only root rows carry details.
   Do not use `PT403` for this case, because hosts terminate a session on
   `forbidden`. Validate keys, types, 1 to 256 items, unique
   IDs and a request of at most 4 MiB, with `PT400 invalid_request` and
   `PT413 limit_exceeded` errors. Validate detail text limits with
   `octet_length` only, not `char_length`. Upsert each record and replace all
   detail columns.
3. Extend `publish_session_events` to accept and store `priority`,
   `ownerSessionId`, `createdAt`, `updatedAt`, `claimedAt` and `completedAt` in
   row tasks. It currently rejects every task key besides `id`, `title`,
   `status` and `blockedBy` with `PT400`. Deploy this platform migration before
   hosts run the new daemon, or every row publication for a session with tasks
   fails.
4. Delete a session's task details when its row publishes with `shared: false`,
   and prune details for tasks no longer in the row.
5. Send the existing row realtime hint when details change.
6. Show the task description, an acceptance criteria heading, an Activity
   section with notes, results and blocked reasons, and chips for priority,
   owner and dates in the web viewer.

**Current implementation:** The daemon keeps full task records from the runtime
hook. It publishes safe priority values and converts valid lifecycle timestamps
to epoch milliseconds on the row. Hosts replace ill-formed Unicode, including
lone surrogates, in task titles and task text with U+FFFD before publication.
Task text passes through `sanitize(PublishedTaskDetailSchema)` for redaction and
the byte limits above. Hosts cut text that exceeds a byte limit at a code point
boundary. For text within the tool character limits, this happens only when
text averages more than four bytes per tool character, such as long runs of ZWJ
emoji sequences. The host splits detail requests at 256 tasks and 4 MiB.

The connector uploads details only for shared root sessions, after it has
published and indexed their row under the current host. Children never call the
RPC. It checks details even when the row summary has not changed, so notes and
results do not need a row change to upload. It sends only tasks whose sanitized
details changed, with bounded RPC calls, and records each successful batch only
while the platform, connection generation and host remain current. An absent
runtime task snapshot causes no detail upload.

The connector keeps sent details and rejected detail sets only in memory. It
clears them on disconnect, local session removal and a root row publication
with `shared: false`. Reconnect or re-share uploads every task's details again;
the RPC's upsert is idempotent. Detail errors never disconnect the connector or
stop row publication, and `/remote status` lists them as session issues until
the next successful detail upload:

- On an `invalid` error or a host-side failure to build the detail payload or
  its batches, the host skips that detail set until details change or the
  connector reconnects. A missing RPC counts as `invalid`: PostgREST answers
  `PGRST202` with HTTP 404. The next attempt sends every task.
- Retry-class errors, including timeouts and HTTP 408, 429 and 5xx, and
  authorization errors reported as `revoked` leave the details pending. The
  connector retries that root with exponential backoff, from about 1 second up
  to 60 seconds, on a later publish pass. The heartbeat triggers a pass about
  every 30 seconds, and any session change triggers one too. Each detail call
  waits at most 15 seconds, so a timeout can delay other publications in that
  pass once per backoff window.
- `session_deleted` and `forbidden` terminate that session, as they do for row
  publication.

Detail records carry no version. A call that timed out on the host can still
commit on the platform after a newer retry, leaving older text until that task
changes again.

This adds no change types, outbox rows or persisted state.

Release versions for this change are:

| Package | Previous | New |
| --- | --- | --- |
| `@felan-ai/session-protocol` | 0.4.3 | 0.4.4 |
| `@felan-ai/agent-core` | 0.15.7 | 0.15.8 |
| `@felan-ai/ext-tasks` | 0.11.1 | 0.11.2 |
| `@felan-ai/ext-ask-user` | 0.12.1 | 0.12.2 |
| `@felan-ai/ext-background-bash` | 0.15.1 | 0.15.2 |
| `@felan-ai/ext-fusion` | 0.4.1 | 0.4.2 |
| `@felan-ai/ext-prompt-history` | 0.9.3 | 0.9.4 |
| `@felan-ai/daemon` | 0.7.13 | 0.7.14 |
| `@felan-ai/felan` | 0.39.8 | 0.39.9 |

Felan pins the daemon at `workspace:0.7.14`.

## Daemon status for platform change requests

These refer to `platform-cr-N` in the same contract, not the daemon CR numbers
above. Platform RPC, access, route, reader and cleanup changes remain
platform-owned; the daemon-facing status is:

| Platform CR | Daemon status |
| --- | --- |
| CR-4: index before live text | Implemented: live text waits for successful per-host `publish_session_events` indexing, including an empty batch. Persisted `indexedHostId` seeds an in-memory gate on reconnect; upload intent or an acknowledged sequence alone is not proof. |
| CR-6: completion validation/conflict | The executor sends only `accepted`, `rejected` or `indeterminate`, never outcome `expired`; stale expiry is a rejected outcome with error code `expired`. `PlatformClient.complete` checks `re`; the connector treats `conflict` as final and forgets the completed journal entry. |
| CR-8: notification transport fields | `parseRealtimeNotification` uses `parseSchema`, which strips unspecified transport fields, including an extra `id` in an `events` payload. No parser change needed. |
| CR-9: token 400/500 errors | `HostTokenSource` treats HTTP 400 `invalid_request` as retryable `unavailable` and HTTP 500 `internal_error` as retryable `retry`. Adding these names to `HOST_TOKEN_ERROR_CODES` is deferred to `0.1.0-next.1`, not required for retries. |
| CR-15: suspension versus membership removal | The platform membership check returns `not_a_member` for plan suspension or team soft deletion without deleting history. The connector stops on token `not_a_member`; an RPC membership rejection triggers token re-exchange, then the same stop. Once access is restored, `/remote login` or a daemon restart retries with the retained credential/outbox; it does not automatically resume while stopped. |
| CR-16: shared storage namespace | Typed publication `forbidden` (including a cloud-session ID collision) makes only that session terminal, drops its outbox and reports it in `/remote status`. Other sessions continue. Archive naming and cleanup remain platform-owned. |

The remaining platform decisions require no additional daemon wire changes:
CR-1/2/5 are covered by daemon CR6/8/1; CR-3/7/10–14/17 cover platform identity,
notifications, routes, deletion, retention and readers. Re-pair after a local
platform database reset. Deferred protocol changes must be coordinated with the
platform database allow-list before hosts publish new change types.

## Story 3 platform change requests

Answers to `platform-cr-20` to `platform-cr-22` (raised 2026-10-19). They ship in
`@felan-ai/session-protocol` 0.2.0 and `@felan-ai/daemon` 0.2.0.

| Platform CR | Daemon answer | Implementation |
| --- | --- | --- |
| CR-20: channel instructions on remote create | Amend: root session only | Remote and local `sessions.create` accept optional `instructions`, at most `LIMITS.instructionsBytes` (16 KiB). The daemon stores them in the root's session profile and appends them to that root's base system prompt, after any host `APPEND_SYSTEM.md`. Every turn therefore carries them, including turns of runs triggered by completion notices, and compaction, eviction, reload and restarts keep them. A Pi extension that replaces the whole system prompt can still drop them. Clone and fork copy them. Child executions do not inherit them: rules such as `<no_response/>` would make a subagent return nothing to its parent. The connector advertises `capabilities.features: ['sessions.create.instructions']`. |
| CR-21: `channel` origin kind | Accept | `OriginSchema` adds `{ kind: 'channel', provider, user, command }`; `provider` matches `^[a-z][a-z0-9_-]*$`, at most 64 bytes. The provider comes from a nullable `channel_provider` field on the claimed `session_commands` row, which `RemoteCommandRow` carries as `channel: { provider }`. With it set, runs, queue items and messages get the channel origin, and the provider joins the command's journal identity. Without it, provenance stays `{ kind: 'web', user, command }`. Admission principal and answer authority are unchanged. |
| CR-22: chat answers | No change | The broker still rejects answers that do not match the request's kind, options or fields. |

Platform follow-ups, in order:

1. Upgrade `apps/web` and `e2e` to `@felan-ai/session-protocol` 0.2.0. Readers on
   0.1.x reject rows that carry a `channel` origin, and CR-17 makes readers skip
   them. Update `apps/web/lib/channels/presenter/present.ts` so `channel` origins
   are not treated as terminal prompts attributed to the host owner. Keep the
   `channel_thread_id` lookup for hosts that still send web origins.
2. Then add a `channel_provider` column to `session_commands`, set once from the
   thread's provider when the row is inserted, and never change it. Do not derive
   it at claim time by joining `channel_threads`: the provider is part of the
   command's journal identity, so a value that changes between claims makes a
   re-claimed command fail with `request_conflict` instead of replaying its
   outcome. Rows inserted before the column exists keep a null provider. Daemons
   before 0.2.0 ignore the field and keep the web origin.
3. When `hosts.capabilities.features` includes `sessions.create.instructions`,
   send the channel rules as `params.instructions` and keep only `[Thread context]`
   and `[Current message]` in the first prompt. For other hosts, keep the interim
   prompt: older daemons drop unknown params silently.

`host_register` already stores unknown capability keys, so registering the new
`features` key needs no migration. Readers on 0.2.0 keep unknown feature
values, so later features stay readable.

Rolling back a daemon from 0.2.0 to 0.1.x after it has recorded a channel origin
is unsupported: 0.1.x cannot parse that origin in its stored control state.

## Remote model and thinking selection

The remote command protocol accepts `set_model` with the local operation's
`{ provider, id }` parameters and `set_thinking` with `{ thinking }`. Hosts
advertise both operation names in `HostCapabilities.operations`; the platform
must keep the controls disabled for hosts that do not advertise them. The
daemon restores a nonresident shared session before submitting either operation
through the same admission and local validation path as local commands. Model
selection checks provider authentication and the session's available and
scoped models. Rejections (`not_found`, `unavailable` or
`authentication_required`) do not change the selection or publish
`model.updated`. Each accepted command publishes the current `model` and
`thinking` together, including an accepted no-op. Startup and recovery also publish the current pair, and
the local session transcript stores `model_change` and
`thinking_level_change` entries for resume. These commands do not change the
host's configured model or thinking defaults.

The protocol schema and daemon implementation are prepared on BUG-465's branch;
they are not yet released. The following are proposed versions, pending a
human-reviewed merge to `main` and the CI-triggered npm release workflow:

| Package | Current | Proposed |
| --- | --- | --- |
| `@felan-ai/session-protocol` | 0.4.4 | 0.4.5 |
| `@felan-ai/ext-ask-user` | 0.12.2 | 0.12.3 |
| `@felan-ai/ext-background-bash` | 0.15.2 | 0.15.3 |
| `@felan-ai/ext-fusion` | 0.4.2 | 0.4.3 |
| `@felan-ai/ext-prompt-history` | 0.9.4 | 0.9.5 |
| `@felan-ai/agent-core` | 0.15.8 | 0.15.9 |
| `@felan-ai/daemon` | 0.7.14 | 0.7.15 |
| `@felan-ai/felan` | 0.39.9 | 0.39.10 |

Do not start BUG-425 until these versions are confirmed published and the
platform consumes the released protocol and daemon packages.

## Remote skill invocation

The remote command protocol accepts `command.invoke` with the local operation's
parameters: `{ name, arguments, attachments?, delivery? }`. Hosts advertise the
operation name in `HostCapabilities.operations`; the platform must hide skill
commands for hosts that do not advertise it. `prompt` still carries literal
text: a `/skill:name` prompt reaches the model unexpanded. `steer` and
`follow_up` are different. Pi's queue expands `/skill:name` text in them and
reads the skill file on the daemon host, not through the session runtime. A
channel that sends `steer` or `follow_up` during a run can therefore run a
daemon-host skill by text. Until the daemon closes that gap, the platform should
not send user text that starts with `/skill:` through those two operations.

A remote caller can invoke only catalog commands of kind `skill`, named
`skill:<name>`. The daemon reads the skill file through the session's
`AgentRuntime`, so a skill stored in a remote workspace expands the same way as
a local one. The daemon rejects a file that it cannot read, that exceeds
256 KiB, or that is not valid UTF-8 with `unavailable` before it starts a run.
An unknown name, or an extension command name, also returns `unavailable`. The
error message lists up to three close skill names, for example
`Unknown or unavailable command: /skill:revew-pr. Did you mean /skill:review-pr?`.
The platform can show that message as is.

`attachments` has the same shape as prompt attachments and joins the expanded
skill in the user message. Without `delivery`, the command starts a run and
returns `{ status: 'started', runId }`; it returns `busy` during an active or
pending run. With `delivery: 'steer'` or `'follow_up'`, the daemon queues the
expanded skill like the matching prompt operation and returns
`{ status: 'queued', itemId }`. A remote `follow_up` on an idle session starts a
run and returns `started`. The result is `{ status: 'completed' }` when an input
handler consumes the input without queuing it.

The stored and published user message is Pi's skill block followed by the
arguments:

```text
<skill name="NAME" location="PATH">
References are relative to DIR.

BODY
</skill>

ARGUMENTS
```

The TUI parses this text with Pi's `parseSkillBlock` and renders a collapsed
skill row above the arguments. The platform should apply the same parser to
user messages instead of rewriting the stored message.

The protocol schema and daemon implementation are not yet released. The
following are proposed versions, pending a human-reviewed merge to `main` and
the CI-triggered npm release workflow:

| Package | Current | Proposed |
| --- | --- | --- |
| `@felan-ai/session-protocol` | 0.4.5 | 0.4.6 |
| `@felan-ai/ext-ask-user` | 0.13.0 | 0.13.1 |
| `@felan-ai/ext-background-bash` | 0.16.0 | 0.16.1 |
| `@felan-ai/ext-fusion` | 0.5.0 | 0.5.1 |
| `@felan-ai/ext-prompt-history` | 0.10.0 | 0.10.1 |
| `@felan-ai/agent-core` | 0.16.0 | 0.16.1 |
| `@felan-ai/daemon` | 0.8.0 | 0.8.1 |
| `@felan-ai/felan` | 0.40.0 | 0.40.1 |

## Remote compaction

The remote command protocol accepts `compact` with optional
`{ instructions?, method? }` parameters. `instructions` holds focus
instructions for the summary, 1 byte to `LIMITS.instructionsBytes` (16 KiB) of
UTF-8. `method` is optional and must be `summary`; the protocol rejects any other
value with `invalid_request`. Hosts advertise the operation name in
`HostCapabilities.operations`; the platform must hide the compact control for
hosts that do not advertise it.

The daemon runs a remote compaction through the same admission path as a local
`/compact`. An accepted command starts a run with the web, channel or
automation origin and returns `{ runId }`. The run publishes `run.updated` when it
starts and settles, and the compaction summary arrives as a `system`
`message.completed`. During an active or pending run the command returns
`busy` and changes nothing; the daemon does not queue it until the run ends.
When the session has nothing to summarize, because it already ends in a
compaction or every message since the latest compaction falls within the recent
context that compaction keeps, the command returns `unavailable` with a message
that explains why, starts no run and changes nothing. The platform shows that
message to the person who asked.
`steer` and `follow_up` commands sent during the compaction return
`{ itemId }`, appear in `queue.updated`, and the daemon delivers them in the
same run after the compaction finishes. A retried command with the same ID
returns the original outcome without compacting again.

The protocol schema and daemon implementation are not yet released. The
following are proposed versions, pending a human-reviewed merge to `main` and
the CI-triggered npm release workflow:

| Package | Current | Proposed |
| --- | --- | --- |
| `@felan-ai/session-protocol` | 0.4.6 | 0.4.7 |
| `@felan-ai/ext-ask-user` | 0.13.1 | 0.13.2 |
| `@felan-ai/ext-background-bash` | 0.16.1 | 0.16.2 |
| `@felan-ai/ext-fusion` | 0.5.1 | 0.5.2 |
| `@felan-ai/ext-prompt-history` | 0.10.1 | 0.10.2 |
| `@felan-ai/agent-core` | 0.16.1 | 0.16.2 |
| `@felan-ai/daemon` | 0.8.1 | 0.8.2 |
| `@felan-ai/felan` | 0.40.4 | 0.40.5 |

## Idle hold for host restarts

`host.stop` and `host.restart` accept `mode: 'hold'` next to `drain` and
`force`, both as v1 operations and as authenticated control requests
(`{ control: 1, op: 'host.restart', params: { expected, mode: 'hold' } }`).
`host.status` and every control response list the accepted modes in
`stopModes`, for example `['drain', 'force', 'hold']`. A daemon that omits
`stopModes` accepts only `drain` and `force` and rejects `hold` with
`invalid_request`, so a caller checks `stopModes` before sending `hold`.
The daemon closes admission and stops claiming remote commands first, then
counts active runs and interruptible work. Nothing can start between that
count and the decision.

- When both counts are zero, the request is accepted. The response, the
  control response and `host.status` keep `state: 'draining'` and add
  `held: { action: 'stop' | 'restart', since, until }`, with millisecond
  timestamps. `until` is 60 seconds after `since`.
- When a run or interruptible work is active, the request is rejected with
  `busy` and admission reopens. `held` is absent.
- A held daemon accepts `drain` or `force` for either action, and SIGTERM, which
  requests a `drain` stop. It settles and exits in seconds because nothing is
  running. Repeating the same `hold` returns the same `held` value. A `hold` for
  the other action returns `busy`.
- If no stop or restart arrives before `until`, the daemon reopens admission and
  claims remote commands again.

A remote command that the daemon refuses with `busy` because admission closed
during its submission is no longer completed. It stays `claimed`, and the daemon
forgets the undispatched control request. Its journal entry is marked
`deferred` so that the next claim, by this daemon after the hold expires or by
the next daemon, submits it once. A deferred command whose `expiresAt` passed
before that claim completes as `expired`, as a fresh command would. If the
daemon crashes between forgetting the request and writing the journal mark, the
next claim completes the command as `indeterminate` instead of running it.

`host.status` adds `active.workByKind: { sessions, processes, interactions,
providers }`. `work` is their sum. `sessions` counts busy resident sessions,
including child executions. `processes` counts in-flight runtime operations and
live non-detached processes, such as a shell command promoted to the background.
`interactions` counts unanswered host questions. `providers` is 1 while a
service provider reports itself busy. Clients that predate these optional
fields ignore them.

The protocol schema and daemon implementation are not yet released. The
following are proposed versions, pending a human-reviewed merge to `main` and
the CI-triggered npm release workflow:

| Package | Current | Proposed |
| --- | --- | --- |
| `@felan-ai/session-protocol` | 0.4.7 | 0.4.8 |
| `@felan-ai/ext-ask-user` | 0.13.2 | 0.13.3 |
| `@felan-ai/ext-background-bash` | 0.16.2 | 0.16.3 |
| `@felan-ai/ext-fusion` | 0.5.2 | 0.5.3 |
| `@felan-ai/ext-prompt-history` | 0.10.2 | 0.10.3 |
| `@felan-ai/agent-core` | 0.16.3 | 0.16.4 |
| `@felan-ai/daemon` | 0.8.4 | 0.8.5 |
| `@felan-ai/felan` | 0.40.7 | 0.40.8 |

## Holding active runs for host restarts

A daemon that holds active runs adds `holdsRuns: true` to the `host.status`
result and to every control response, next to `stopModes`. A daemon without the
field answers a `hold` on a host with an active run with `busy`, as in the
idle-hold contract above. A caller checks `holdsRuns` before it sends `hold` to
a busy host or sends `stepTimeoutMs`. Callers built against
`@felan-ai/session-protocol` 0.4.8 ignore the field and keep working.

`host.stop` and `host.restart` accept an optional `stepTimeoutMs` with
`mode: 'hold'`: an integer from 1 to 600000 milliseconds, 180000 when absent.
With `drain` or `force` it is rejected with `invalid_request`. A daemon without
`holdsRuns` rejects it in control requests, whose parameters are strict, and
ignores it in v1 envelopes.

- With no active run, a hold behaves as the idle hold above. On a daemon with
  `holdsRuns`, `held` also carries `runs: 0`.
- With active runs, the daemon closes admission and remote claims and the
  response waits. Each run, subagent runs included, finishes its current step:
  the model response in flight and the tool calls it asked for. It stops after
  their results are saved and before the next model request. A step whose
  response asked for no tool calls, or whose tool calls end the run, takes its
  normal course; that run ends or holds at a later step. Busy providers and
  in-flight runtime operations keep the hold waiting too.
- If an interaction waits for a person (state `waiting`, any scope) or a live
  non-detached process runs when the hold arrives, the daemon answers
  `outcome: 'rejected'`, `state: 'ready'`, `error.code: 'busy'` at once and
  reopens admission and remote claims. Neither ends by itself while admission
  is closed. If such a question appears while the hold waits, or a live process
  remains once every run waits, the attempt ends at once with
  `hold_cancelled`.
- While a daemon still continues the runs its predecessor held, or still
  restores at startup the sessions whose background jobs may still run or
  still owe a finish notice, it answers every hold with `busy` without closing
  admission. That includes a hold on a host with no active run.
- Once every run is held and nothing else runs, the daemon writes one continue
  record per held run (`version: 1`) and answers `outcome: 'accepted'`,
  `state: 'draining'`, `held: { action, since, until, runs }`, where `runs` is
  the number of held runs and `until` is 60 seconds after `since`. If no stop or
  restart arrives before `until`, admission reopens and the held runs continue
  in the same daemon.
- If a run has not reached its step end within `stepTimeoutMs`, the attempt is
  cancelled: the response is `outcome: 'rejected'` with `state: 'ready'`, no
  `held`, and `error.code: 'hold_cancelled'`. Held runs continue at once,
  admission and remote claims reopen, and nothing is interrupted.
- A `drain` or `force` request, or SIGTERM, that arrives while the hold still
  waits replaces it: the hold request answers `busy` and the runs continue under
  that stop. One that arrives after `held` stops the daemon without interrupting
  the held runs. They stay `running` with `residency: 'evicted'`. A run that
  started after `held` is held too if it reaches a step end: a drain stop waits
  for that, and a force stop interrupts it. A subagent completion that the
  daemon can still deliver to an idle parent, either in flight or owed, keeps
  a drain stop waiting, so the run it starts is held at a step end too.
- A held run stays `running` to every client. The protocol has no new run state.
- Cancelling or closing a held session, or interrupting its run, deletes its
  record. While a hold is active, a subagent completion reaches its parent
  only if the parent is resident and idle. That starts a run in the parent,
  which the hold waits for or holds like any other. A completion for a busy
  parent waits until the hold ends or the next daemon restores the parent.
  Subagents queued while admission is closed start once the hold ends, and a
  restart cancels them with `host_shutdown`.
- A custom message an extension steers into a held run waits in Pi's queue,
  and the stop that ends the run drops it. The record keeps only user
  messages. The owner delivers such a message again only if it marks it
  delivered after Pi stores it. The daemon does this for subagent
  completions, and `@felan-ai/ext-background-bash` does it for finish
  notices from 0.17.1.

When a stop ends a held run, Pi may append context it kept for the step's end,
such as custom messages sent with `triggerTurn: false`. If only custom
messages and entries, bash or custom messages, labels or session info follow
the recorded entry, the record moves to the transcript's last entry. Anything
else keeps the recorded entry, and the next daemon interrupts the run.

The next daemon reads the records at startup and deletes them. For each record
whose session is still open, has the same run `running` or `waiting`, and whose
transcript still ends at the entry recorded at the hold, it restores the session
and its parent sessions. It re-queues the saved steering and follow-up user
messages and continues the run under its run ID. It starts the next step with
a hidden custom message of type `felan-daemon-run-continued` (`display: false`)
whose text is "Notice from the session host, not from the user: the host
restarted after the tool results above were saved. Continue the task from
where you stopped." A subagent's record counts the held step toward its turn
limit; when the next step is its last, its tools are removed and the summary
instruction is queued after the saved messages. When the held step used its
last turn, the subagent finishes as `cancelled` with `turn_limit_reached` and
takes no further step, as its unheld run would have. A record that is unreadable,
of another version or no longer matches leaves its run `interrupted`, as a
restart does today, and so does a continued run whose next step fails. A
subagent whose run cannot continue finishes as `cancelled` with
`host_shutdown` and its parent is told. A crash during the continued run also
interrupts it, because the record is already consumed.

An extension whose in-memory state a restored session cannot rebuild can keep
its session's run from being held. It subscribes to `RUN_HOLD_EVENT`
(`'felan:run-hold'`, exported by `@felan-ai/agent-core`) on `pi.events` and
calls `event.refuse(reason)` from a synchronous handler. The run then takes its
next step instead of holding. `@felan-ai/ext-prewalk` refuses while Prewalk is
active, and `@felan-ai/ext-codex` refuses while it owes the run a deferred
compaction. [ADR 0050](../decisions/0050-hold-active-runs-at-a-step-end.md)
records the design.

The protocol schema and daemon implementation are not yet released. The
following are proposed versions, pending a human-reviewed merge to `main` and
the CI-triggered npm release workflow:

| Package | Current | Proposed |
| --- | --- | --- |
| `@felan-ai/session-protocol` | 0.4.8 | 0.4.9 |
| `@felan-ai/agent-core` | 0.16.4 | 0.16.5 |
| `@felan-ai/ext-prewalk` | 0.15.0 | 0.15.1 |
| `@felan-ai/ext-ask-user` | 0.13.3 | 0.13.4 |
| `@felan-ai/ext-background-bash` | 0.17.0 | 0.17.1 |
| `@felan-ai/ext-fusion` | 0.5.3 | 0.5.4 |
| `@felan-ai/ext-prompt-history` | 0.10.3 | 0.10.4 |
| `@felan-ai/ext-codex` | 0.13.0 | 0.13.1 |
| `@felan-ai/daemon` | 0.8.6 | 0.8.7 |
| `@felan-ai/felan` | 0.40.9 | 0.40.10 |

## Passive runtime operations

`AgentRuntime` has an optional `passive(operation)`. The daemon's runtime
implements it: runtime calls made inside the operation are not counted in
`host.status` `active.work` or `workByKind.processes`, and they do not block
session eviction. A stop still waits for them to end, and from daemon 0.8.9 a
passive operation that fails does not fail the stop. A runtime without the
method runs the operation as usual, so a caller falls back to calling it
directly.

`@felan-ai/ext-background-bash` polls each running job every 500 ms and now
does so inside `passive`. Before, every poll counted as work. On a remote
runtime a poll is a network round trip, so a host whose only activity was a
promoted command reported `work: 1` most of the time and never accepted an
idle hold.

The following are proposed versions, pending a merge to `main` and the
CI-triggered npm release workflow:

| Package | Current | Proposed |
| --- | --- | --- |
| `@felan-ai/agent-core` | 0.16.5 | 0.16.6 |
| `@felan-ai/ext-background-bash` | 0.17.1 | 0.17.2 |
| `@felan-ai/daemon` | 0.8.7 | 0.8.9 |
| `@felan-ai/felan` | 0.40.10 | 0.40.12 |
