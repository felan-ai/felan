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

**Proposed change:** Confirm that the authenticated PAT owner may answer
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

**What:** A new PAT creates a new host and “never inherits upload authority or
history,” but the fate of old local outboxes is not explicit.

**Why:** Keeping an outbox after `invalid_pat` is not a promise that a new PAT can
upload it. The old host still owns its published sessions.

**Proposed change:** State that previously published sessions cannot be continued
by the new host: they are read-only/terminal from that host's perspective, and
their local outboxes are dropped. Retained entries for an old pairing can resume
only if the same PAT is restored and the platform still authorizes that pairing.

**Platform decision:** Accept — “Previously published sessions cannot be continued by the new host”; old-pairing outboxes are dropped.

**Current implementation:** `remote/connector.ts` persists the publishing host ID.
On reconnect with a different host, it marks those sessions terminal `forbidden`,
drops their outboxes and reports them in `/remote status`. This does not delete
the old platform history or the local sessions. Outboxes are kept while stopped
on `invalid_pat`; once a different PAT pairs a different host, the old host's
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

## 16. Local PAT and service-role test fixtures

**What:** The contract requires tests against local Supabase without documenting
how to obtain a local PAT or privileged fixture access.

**Why:** A hash convention or signing-key mismatch can look like a connector
failure. Contributors must not use production credentials or start another stack.

**Proposed change:** Document the local fixture path, prerequisite migrated stack
and shared signing key, and the PAT storage convention: SHA-256 of the complete
`fln_pat_...` token encoded as lowercase hex in `api_keys.key_hash`, with
`scope = 'personal'`, `user_id`, `team_id`, and `encrypted_key = null`. Explain
how a developer obtains a PAT through web settings or disposable test fixtures.

**Platform decision:** Accept — “a local test environment section”: `local:pair-host`, settings, signing key and `key_hash` convention.

**Current implementation:**
`apps/daemon/test/support/remote-supabase.ts` creates disposable owners, teams,
PAT hashes and hosts. It reads the local platform's
`supabase/signing_keys.json` and signs a short-lived service-role token for
fixture setup/cleanup; it does not require a production service key or persist
the plaintext PAT. RPC tests use scoped host tokens. The integration suite never
starts Supabase. Commands and prerequisites are in
[the connector guide](remote-connector.md#local-development-and-testing).

## 17. Token endpoint

**What:** Comparison of the platform's `POST /api/v1/hosts/token` route
(`apps/web/app/api/v1/hosts/token/route.ts` in felan-platform) with the contract
and `remote/token.ts`. No change is requested.

**Why:** Recorded so the comparison is not repeated and so a later divergence is
visible.

**Proposed change:** None. Path, Bearer PAT, request body (`installId`, name byte
limit, `daemonVersion`, `protocol`, `rowSchemaVersion`), response body (`token`,
`expiresAt`, `refreshAt`, `host`, `supabase`), status codes (400, 401, 403, 426, 429,
5xx), the flat error body `{ code, message, supported? }`, and the ES256 claims
(issuer, audience, role, host subject, `felan` claims, lifetime of at most 900
seconds) all match the contract.

**Platform decision:** No change — “Comparison only.”

**Current implementation:** `remote/token.ts` requires no contract change. The
endpoint tests in `remote-supabase.integration.test.ts` cover exchange with a
personal PAT, stable host ID for the same PAT and install ID, and 401 `invalid_pat`
for a revoked key; they skip when the local API is unavailable. Unknown token
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
| CR-15: suspension versus membership removal | The platform membership check returns `not_a_member` for plan suspension or team soft deletion without deleting history. The connector stops on token `not_a_member`; an RPC membership rejection triggers token re-exchange, then the same stop. Once access is restored, `/remote login` or a daemon restart retries with the retained PAT/outbox; it does not automatically resume while stopped. |
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
