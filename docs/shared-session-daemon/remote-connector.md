# Remote connector

The daemon's remote connector publishes selected local sessions to Felan and
accepts platform-authorized commands. Personal hosts require the token's owner;
team hosts accept any requester or no requester. Local session execution and
persistence remain in the daemon; losing the connection does not stop local
work. The connector exchanges a browser-paired machine credential or a team API key for a
scoped host token and communicates with the platform through RPCs and private Realtime
channels.

- Publishes a session index and a bounded, chronological copy of shared history.
- Broadcasts live text without storing the text stream on the platform.
- Accepts remote create, prompt, steer, follow-up, cancel and interaction-answer commands
  through normal daemon admission.
- Keeps a durable outbox and command journal for disconnects and restarts.

## Pair this machine

1. In the TUI, run `/remote login`. The TUI shows a code such as `BCDF-GHJK` and a
   Felan link, and tries to open the link in a browser.
2. Sign in to Felan, check the machine name and code, choose the team and approve.
   The daemon polls Felan and receives this machine's credential once approval
   is recorded. Cancelling the wait keeps any existing pairing.
3. Run `/remote status` to inspect the connection, sharing mode, pending events,
   shared-session count and opened projects.
4. Share a session with `/remote on`, or choose a host default as described below.

A machine is identified by team, user and installation ID. Approving the same
installation again, for example after the machine was revoked on the web, restores
the same host and rotates its credential, so shared sessions keep publishing.

The daemon stores the machine credential through its credential-storage provider,
using namespace `remote` and key `pat`. Felan's local provider uses the OS keychain
(service `felan.remote`, account `pat`). Credentials keep the `fln_pat_` prefix for
redaction. They are never stored in `host.json` or settings files. Host tokens are
cached in memory and renewed at `refreshAt`.

`/remote logout` removes the saved credential and stops the connector. It does not
delete local sessions, the outbox or previously published history. Login and logout
are daemon-wide for this agent directory, not per TUI attachment.

### Headless team hosts

A managing package can supply a file-backed secret-storage provider whose
`read('remote', 'pat')` returns a team API key (`bzy_team_…`). The connector starts
automatically with any nonempty stored credential; no `/remote login`, TTY or
OS keyring is required. A token response without `host.userId` identifies a team
host; requester authorization belongs to the platform.

Set an optional authoritative `remote` section in `host.json`:

```json
{
  "remote": {
    "share": "all",
    "projects": [
      { "id": "workspace", "name": "Team workspace", "path": "/home/agent/workspace" }
    ]
  }
}
```

`share` is `all` or `on-request`. Project IDs and absolute normalized paths must
be unique. These settings override, but do not overwrite, the connector's stored
sharing default and projects. `/remote share`, `/remote open` and `/remote close`
are refused while this section is present. Remove it and restart to use the
stored settings again. Per-session sharing choices remain unchanged.

Custom managers launch with `runDaemonProcess(argv, manager)` from
`@felan-ai/daemon/daemon-bootstrap`; supply `packageName`, `version`, a file-URL
`resolveFrom`, `resolveProvider` and `packagedDefaultPath`. Use `--foreground`
and `--host-config /absolute/path/host.json` (or put `host.json` under the
selected agent directory). The first argument is the serialized daemon target:

```ts
await runDaemonProcess([
  JSON.stringify({ kind: 'production', agentDir: '/home/agent/.felan/agent' }),
  '--foreground',
], {
  packageName: '@felan-cloud/agent',
  version: '1.0.0',
  resolveFrom: import.meta.url,
  resolveProvider: specifier => import.meta.resolve(specifier),
  packagedDefaultPath,
});
```

`felan daemon foreground` runs the default manager.
The local provider factories remain available from
`@felan-ai/felan/providers/session-runtime`, `/models` and `/secrets`, allowing
a custom manager to replace secret storage without replacing session composition.
Session `prepare` and `bindExtensions` receive `execution?: { label?: string }`;
child execution labels are the subagent definition IDs.

### API URL

The default is `https://app.felan.ai`. For local development, use:

```text
/remote login http://localhost:3000
```

An explicit URL is saved as `apiUrl` in the connector's settings. Without one,
the daemon uses its configured API URL, then `FELAN_API_URL` from the daemon's
environment, then the default. Set environment overrides when starting the
daemon, not merely when attaching a client to an already running daemon.

HTTPS is required except for loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`).
URLs with embedded credentials, query strings or fragments are refused. Omitting
the URL on a later login retains a previously saved override.

## Sharing

| Command | Behavior |
| --- | --- |
| `/remote` or `/remote status` | Show connector status; make no sharing change |
| `/remote share on-request` | Default: share only explicitly enabled local sessions, plus web-created sessions |
| `/remote share all` | Share local sessions by default; explicit per-session opt-outs still apply |
| `/remote on` | Enable sharing for the attached session's root and its children |
| `/remote off` | Disable sharing for that root and its children; keep already published history |

Nothing is shared until this machine is paired. Per-root-session choices survive
restart and take precedence over the host default. Changing sharing from a child
affects its root and sibling sessions too.

A first share backfills the session's local history and publishes current state.
Backfill runs after the projection callback returns; live changes wait in a
bounded 4 MiB per-session buffer and changes covered by the snapshot are removed.
If a snapshot is temporarily unavailable, no partial history is appended;
later publishable changes or residency retry it, at most once per second.
Presentation, catalog and live-text events do not trigger backfill.

After `/remote off`, a session whose upload was ever attempted sends `shared: false` without
events, then stops sending. The stored web copy becomes read-only; stopping
sharing deletes nothing. Previously queued events remain local until sharing
resumes. If nothing has been published or sent yet, turning sharing off instead
discards the local outbox and sends nothing, including no title or directory.
Turning it on again backfills fresh from sequence 1. Upload intent and the host ID
are persisted before the first request: a lost response does not count as an
unattempted upload and never permits sequence reuse. A request already in flight
cannot be unsent.

After off → on for a previously published session, changes made during the
unshared interval are not uploaded. The
connector does not currently publish a gap marker. This is distinct from
first-time sharing, which does backfill history.

Web-created sessions are always shared while the connector is configured and
authorized. `/remote off` is refused for them; use `/remote logout` to stop the
connector entirely. A terminal publication record cannot be re-enabled with
`/remote on`.

## Content and privacy

Only shared sessions enter the publication pipeline. Its publish set is:

```text
message.completed, tool.updated, run.updated, queue.updated,
interaction.requested, interaction.resolved, metadata.updated,
model.updated, child.updated, stream.completion_only
```

The connector does not upload presentation changes, catalogs, policies,
execution/process changes or branch changes. Branches and forks are not
represented on the web; the published copy is chronological, not a browsable
local session tree.

Session directory metadata contains only the final path segment, not the full
working directory. Opened projects are an exception: registration includes their
full canonical local paths. Credential redaction is not a general path scrubber;
paths or sensitive content written into messages and tool output can still be
published. Share only sessions whose content is appropriate for the platform.

Before publication, credential-shaped strings and secret-named content fields
are redacted. Inline image data is replaced with `[image omitted]`. Tool output
is limited to 4,096 Unicode characters and marked `truncated` when shortened.
Eligible text may be shortened further to fit the 1 MiB limit per change. A
change that cannot fit without invalidating its structure is skipped, without
consuming a sequence number. Recording continues; `/remote status` reports the
persistent per-session count as “N changes could not be published.” No omission
marker is uploaded, so the web copy may be incomplete.

Live text is redacted and sent only after successful indexing under the current
host, by private Broadcast in chunks of at most 32 KiB. The connector persists
`indexedHostId` only after a successful publish, including zero-event publishes,
and restores its in-memory send gate from that marker on reconnect or restart.
Existing shared records without the marker get a one-time publish even with an
empty outbox; upload intent and acknowledged cursors alone are not proof.
The first available chunk is sent immediately once its channel is ready;
later chunks are coalesced to no more than four messages per second per stream.
It is not stored as
a text stream or durably queued for replay. A bounded in-memory buffer waits for
the session channel to subscribe; exceeding its bound drops the oldest complete
stream. Stored `message.completed` changes provide the completed content. Live
text can be lost during a disconnect.

Deltas before indexing are dropped after advancing the sanitizer, so later
chunks retain their original Unicode-code-point offsets. If the web missed
offset 0, its `classifyTextDelta` / `applySessionText` path discards the gap rather
than rendering a partial stream; stored completion supplies the content. This
matches the contract's display-only live text model. Optional CR 23 presence and
replay from offset 0 are not implemented; indexing does not introduce replay or
reset offsets.

## Remote projects

In an attached session, run `/remote open [name]` to open its current directory
for remote session creation. The optional name is a display label. The daemon
canonicalizes the directory and keeps an ID-to-path mapping; the web sends a
project ID, never an arbitrary working-directory path.

Run `/remote close` in that directory to remove the grant for future creates.
It does not close existing sessions or delete their published history.
`/remote status` lists the opened projects.

Opening a project is a standing, non-interactive grant to create sessions
there. The host's `piExtensions.user` and `piExtensions.project` settings,
both off by default, apply to web-created roots just as to other new roots.
A remote create never prompts for folder trust: project extensions load only
for folders already trusted locally, directly or through a parent. Undecided
folders are skipped without saving a decision, so a later TUI create can still
ask. Opening a project grants neither extension trust nor permission to supply
explicit extension paths; remote creates cannot supply them. It does not
itself turn on sharing for existing local sessions.

Children load their root's external extension paths; worker tool allowlists
still limit active tools. Enabling these host settings runs external extension
code with the user's permissions in web-created and child sessions too.
No creation source is recorded; web run/queue provenance remains unchanged.
The daemon implements this policy ahead of the platform's decision on
[CR 24](contract-change-requests-felan.md#24-host-configured-external-extensions-for-web-created-sessions),
at the user's request.

## Remote commands

The connector advertises these operations:

| Operation | Behavior |
| --- | --- |
| `sessions.create` | Resolve an opened project ID, create a shared root using optional `sessionId` and host-configured external extensions without a trust prompt or explicit paths, apply optional `instructions` to that root's system prompt, optionally submit an initial prompt; successful remote result is `{ sessionId }`, the same as local create |
| `prompt` | Submit a prompt through daemon admission |
| `steer` | Steer through the normal session operation |
| `follow_up` | Queue a follow-up during an active run; start a new prompt turn when idle (`{ status: 'handled' }`) |
| `cancel` | Cancel the current run, optionally matching a run ID |
| `interaction.answer` | Answer an eligible session interaction through the broker; first valid answer wins |

Commands other than create require a shared session. An `automation_source`
produces `{ kind: 'automation', source }` provenance. Otherwise a claimed row
with `channel_provider` produces `{ kind: 'channel', provider, user?, command }`.
All other commands require a requester and produce `{ kind: 'web', user, command }`.
Requester, channel and automation source participate in journal identity. Claims
do not bypass daemon admission or interaction validation.

The `sessions.create.session-id` capability permits an optional lowercase UUID
`sessionId`. The daemon creates that exact root identity and rejects an identity
already registered locally; ordinary command retries return their retained result.

Create `instructions` (at most 16 KiB) are appended to that root's base system
prompt, after any host `APPEND_SYSTEM.md`, so every turn and compaction keep
them. They are stored in the session profile, survive eviction, reload and daemon
restarts, and are copied by clone and fork. Child executions do not inherit
them. The connector advertises this with
`capabilities.features: ['sessions.create.instructions', 'sessions.create.session-id']`; a platform sends
`instructions` only to hosts that advertise it, because older hosts drop the field.

An authorized personal-host owner or team-host caller may answer session-scoped
owner-authority interactions. Host-scoped
questions and `authority: 'local-console'` questions cannot be answered remotely.
Local-console interactions may appear in published history for display, without
remote answer authority.

If session creation succeeds but its initial prompt fails, the shared session
remains. The command outcome reports the prompt failure without a session ID;
inspect the session list before issuing a new create.

The durable command journal prevents a re-claimed command from running twice
when its record survives. For a daemon or process crash, it returns the recorded
outcome, or `indeterminate` when completion cannot be established. With the
control store's `synchronous=NORMAL` durability, an OS crash or power loss can
lose that record; the same command ID can then be admitted and run again, as
with local request deduplication. A full database rebuild uses the more
conservative recovery described below. If the platform rejects a completion
payload, the connector tries a minimal non-retryable `rejected` outcome and
continues processing other commands. A notification during a claim pass schedules
another pass, including when a completion was deferred. The connector also claims
when it subscribes or resubscribes to its `host:<host_id>` channel. Without a new
notification, deferred completions wait for the next heartbeat rather than
spinning. An unknown outcome is not evidence that no local work occurred.

Expiry is evaluated using one timestamp per returned claim batch, with five
seconds of clock-skew allowance. A `claimed_at` at or after the call start
(minus that allowance) identifies a fresh claim: the platform already admitted it
before expiry. Older, unjournaled claims whose expiry passed before the batch
arrived are rejected as `expired`. Slow processing of an earlier command cannot
expire later commands in that same batch. Journaled rows retain replay behavior.

## Status and troubleshooting

| State | Meaning and action |
| --- | --- |
| `off` | This machine is not paired; use `/remote login` to pair it |
| `connecting` | Browser pairing, token exchange, registration or connection setup is in progress; while pairing, status includes the code and link |
| `connected` | Connector is registered and processing publication/commands; inspect the status message for per-session failures |
| `offline` | Connection or service is unavailable; retry uses backoff and local work continues. Check the API URL and network |
| `stopped` | Automatic publication has stopped for an authorization or schema failure; resolve the reason below |

| Stopped reason | Action |
| --- | --- |
| `invalid_pat` | The machine credential is unknown, revoked or belongs to another installation. Run `/remote login` and approve this machine in the browser |
| `not_a_member` | Restore the required team membership or pair with an authorized account; the platform may have deleted the old published history |
| `host_revoked` | The machine was revoked on the web. Run `/remote login` and approve it again; the same host is restored |
| `pairing_denied` | The pairing request was denied in the browser. Run `/remote login` to try again |
| `pairing_expired` | The pairing code expired before approval. Run `/remote login` for a new code |
| `unsupported_schema` | Update Felan/the daemon to a supported protocol and row schema; status includes supported versions when provided |

The outbox is retained while the connector is stopped. Retention does not grant
a new host permission to upload old entries. Previously published sessions are
bound to their publishing host. Re-approving the same installation restores the
same host, so its retained entries resume. If a different host ever publishes them
(for example after a platform database reset), the connector marks old-host sessions
terminal `forbidden` and drops their outboxes.

When the web deletes a session or retention produces a tombstone, publication
becomes terminal `deleted` and that session's outbox is dropped. The local session
is not deleted. `/remote status` reports terminal and blocked sessions in its
message; other sessions can continue publishing.

A non-retryable publication error quarantines only that session's uploads.
Non-platform HTTP 400/404/413/422 and database
content/constraint errors are non-retryable, not terminal. Non-platform 401/403
first trigger token re-exchange; if a session is rejected with 403 again after a
successful exchange, it is quarantined instead of causing a reconnect loop.
Timeouts, rate limits, network errors and 5xx responses remain retryable. Recording continues until storage fails or its
pending outbox reaches 64 MiB per session or 256 MiB across all sessions. Check
its content, local storage and platform state before restarting the daemon.
Exceeding either cap stops new recording for the affected session and warns in
status; its durable backlog can still drain. Storage or integrity failures stop
recording and publication on the affected outbox until restart. A failure inside a
remote transaction that rolls back cleanly affects only that session's outbox.
A failed commit itself (an uncertain outcome) fences the shared control database
and therefore also stops local admission and remote command journaling. The connection can remain active, and status
reports the storage problem (with potentially stale counts). Durable entries are
retained on disk but are not guaranteed to drain during a storage failure. Changes
during that block are not uploaded after restart: the append-only web copy has
no resynchronization mechanism or omission marker. Restart is not a repair for
missing history. Do not delete cursor records or reset sequence numbers to force a
retry.

Deleting a local session that was never uploaded discards its pending uploads
and remote record. If any upload was attempted, the connector retains the record
and sequence until it can send `shared: false`, then drops pending uploads and
removes the local record. The remote history is not deleted; it becomes read-only.
An upload already in flight can still finish. Terminal remote records need no
unshare and are removed immediately on local deletion.

## Persistence

Connector state uses the daemon's existing
`<agentDir>/daemon-control/control.sqlite` and the same `ControlDatabase`
handle. There is no separate remote database or file store. `<agentDir>` is
normally `$FELAN_AGENT_DIR`, default `~/.felan`.

| Table / record kind | Contents |
| --- | --- |
| `remote_records` / settings | Stable installation ID, sharing default, opened projects and optional `apiUrl`; no credential |
| `remote_records` / sessions | Sharing choices, backfill state, pending index updates, durable upload intent, publishing host ID, confirmed `indexedHostId` and terminal state |
| `remote_outbox` | Pending published changes, keyed by `(session, seq)`, with encoded byte sizes |
| `remote_records` / outbox cursor | Acknowledgement/high-water cursor and permanent drop flag |
| `remote_records` / commands | Dispatch state and outcomes for command replay protection |

All writes share the control store's WAL transactions with `synchronous=NORMAL`
([ADR 0042](../decisions/0042-use-normal-synchronous-control-store-commits.md)),
the same ownership checks and the same commit-failure fencing as local control
state. Outbox appends are group-committed once per event-loop tick, or
synchronously before publication. Backfill initialization commits all entries
and its cursor atomically. These writes run on the daemon thread; they are
batched, not asynchronous I/O. A crash can lose the current tick's buffered
changes; they have not been sent to the platform. The publish path flushes before
reading pending entries, so only committed events are uploaded. Invalid
settings/session rows are quarantined; an invalid command journal fails closed
while its record survives.

Committed connector state survives daemon and process crashes. An OS crash or
power loss can roll back recent commits under `synchronous=NORMAL`: recent
settings, opened projects and per-session share flags can revert, and an outbox
or acknowledgement cursor can disagree with publications the web already saw.
The web copy is therefore eventually consistent across that failure boundary; a
few published events can be duplicated, missing or observed out of order.

Publication `seq` is contiguous per session from 1 while its control state is
retained. Daemon `rev` is only a correlation value and may have gaps. Pending
counts and next sequence include buffered entries. The connector persists its
acknowledgement cursor after a successful publish and deletes the acknowledged
range in the same transaction. Indexed range reads/deletes avoid whole-backlog
rewrites. Each durable append wakes publication immediately. If a batch for a
session is in flight, later changes are coalesced for its next batch; there is no
fixed publish delay. The scheduler sends at most one batch for each ready session
per round before revisiting any session.

For `sequence_gap`, the connector acknowledges the platform's confirmed
already-stored prefix within the local cursor range. If the platform's `last_seq`
is ahead of restored local state, including after an OS crash or power loss, it
fast-forwards by renumbering every still-pending entry, including buffered
entries, after that value instead of permanently blocking publication. A recovery
chain permits one such fast-forward across fair scheduling passes and clears only
after a successful publication or when it exhausts pending data. A repeated gap
or another `last_seq` ahead of the outbox is inconsistent and blocks that session
under the existing status behavior. The accepted contract adds no connect-time
`last_seq` read: publish responses and gap details supply it; see
[CR 22](contract-change-requests-felan.md#22-fast-forward-after-restored-publication-sequence-rollback).
Recovery preserves progress, not an exact reconstruction: duplicate, skipped or
reordered web-visible changes around the loss boundary remain possible.

Platform tombstones prevent late retries from recreating deleted history. The
local terminal record and permanent outbox drop prevent reuse of that session's
publication sequence. Preserve the settings, session records and outboxes
together; copying an outbox to a different pairing does not transfer authority.

If control state is corrupt or disappears after initialization, the database is
rebuilt empty and remembers that loss across restarts. Installation identity,
opened projects, sharing defaults and per-session share flags are lost: the
default returns to `on-request`, and users must reopen projects and explicitly
restore sharing. Transcripts remain the durable session record; sharing again
rebuilds the outbox from available history and fast-forwards past the platform's
confirmed `last_seq` when necessary. Missing history is not invented and can
remain absent from the web copy.

Journal rows that survive remain replayable. A daemon or process crash with a
surviving dispatch record recovers as `indeterminate` rather than rerunning the
command. Full-database recovery remains more conservative: every unjournaled
claimed command, including a new command encountered during recovery, is
completed as `indeterminate` without dispatch. Only an empty successful claim
response proves that the old queue has drained; the per-host `command_recovery`
marker is committed before normal dispatch resumes and survives restart. This is
different from an ordinary NORMAL rollback: if an OS crash or power loss loses
journal state without a full rebuild, the daemon cannot establish prior
admission, so the command can be admitted and run again with the same ID, just
as a local request can after its deduplication record is lost. Inspect affected
sessions before retrying commands.

## Local development and testing

Use Node.js `22.20.0` and pnpm `9.15.5`. Run daemon and client tests through
`scripts/test-isolated.sh`; it isolates HOME, agent directories and temporary
paths. For example, from the repository root:

```sh
scripts/test-isolated.sh pnpm --filter @felan-ai/daemon exec vitest run \
  test/remote-state.test.ts test/remote-sharing.test.ts \
  test/remote-content.test.ts test/remote-outbox.test.ts \
  test/remote-token.test.ts test/remote-platform.test.ts \
  test/remote-commands.test.ts test/remote-connector.test.ts
scripts/test-isolated.sh pnpm --filter @felan-ai/felan exec vitest run test/tui-remote.test.ts
```

The Supabase integration suite uses an **already running local** stack with the
platform migrations and `supabase/signing_keys.json`. It never starts, stops,
resets or migrates Supabase. A local web API is needed for token-endpoint tests;
RPC/Realtime tests can run without it.

After a local Supabase database reset, recreate the approving account from the
platform checkout:

```sh
pnpm --filter @felan-ai/e2e local:pair-host -- --email <email> --password <password>
```

Then run `/remote login http://localhost:3000` and approve the code at
`http://localhost:3000/pair` as that user. The reset removed the old host row, so
approval creates a new host; sessions published under the old pairing cannot be
continued (CR 12). Share new sessions for testing. Live text starts only after a session's
first successful publish, including a zero-event publish.

```sh
scripts/test-isolated.sh env \
  FELAN_PLATFORM_DIR=/Users/milkoslavov/workspace/felan-ai/felan-platform \
  SUPABASE_URL=http://127.0.0.1:54321 \
  FELAN_API_URL=http://localhost:3000 \
  pnpm --filter @felan-ai/daemon exec vitest run test/remote-supabase.integration.test.ts
```

Replace `FELAN_PLATFORM_DIR` with the local platform checkout when needed.
Overrides go **after** `scripts/test-isolated.sh`, using `env`, because the wrapper
clears the incoming environment. The helper obtains the local publishable key
through read-only `supabase status`, or accepts `SUPABASE_PUBLISHABLE_KEY` or
`SUPABASE_ANON_KEY` passed the same way. Supabase and API URLs must be loopback.

`test/support/remote-supabase.ts` creates and cleans up disposable fixture users,
teams, machine credentials and hosts, binding each credential to one host as browser
pairing does. It hashes the complete credential with SHA-256 into a
lowercase hexadecimal `key_hash`, sets `scope: 'personal'` and
`encrypted_key: null`, and retains plaintext only in test memory. Using the local
ES256 signing key, it signs short-lived service-role tokens for fixture setup and
scoped host tokens for connector tests. Never substitute production keys or
point these fixtures at a production database.

Missing local Supabase, absent platform schema, missing local signing-key file,
or an unavailable API produce explicit skip messages for the affected suites.
Malformed keys and detected schema/authorization failures are failures, not
silent compatibility passes. A skip is not evidence that integration passed.

## Contract decisions and limits

The host default is `on-request`. After a previously shared session is turned
off and on, the gap is not uploaded. The deferred omission marker and partial-create
result, accepted outcome-parsing rules and other contract decisions are tracked in
[Connector contract change requests](contract-change-requests-felan.md).
