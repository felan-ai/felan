# @felan-ai/session-protocol

Felan's runtime-neutral session protocol v1. This ESM-only package contains
schemas, inferred types, bounded validation and JSON-line framing. Its sole
runtime dependency is `typebox@1.1.38`. It imports no Node, Pi, Agent Core, TUI,
ACP or platform APIs and can run directly in a browser.

0.1.0 was the first public release. 0.2.0 adds the `channel` origin. 0.3.0 adds
team-host identities, remote `follow_up`, client-selected remote session IDs
and automation command origins. Older readers reject these contracts, so they
are breaking minors. Releases follow
[`docs/maintainers/releasing.md`](../../docs/maintainers/releasing.md). The only public subpath is `.`; no daemon or profile
implementation is exported here. Breaking changes require the next minor;
compatible fixes stay within `0.3.x`. Wire, stored-row and mismatch-control
versions are independent constants, initially `1`.

## Boundary API

```ts
import {
  JsonLineDecoder, encodeFrame, parseClientEnvelope, parseServerEnvelope,
} from '@felan-ai/session-protocol';

const decoder = new JsonLineDecoder();
for (const raw of decoder.push(bytesFromAuthenticatedTransport)) {
  const request = parseClientEnvelope(raw);
  // The host must still authorize, admit and execute the request.
}
decoder.finish(); // Reject a truncated final frame at EOF.

// Associate responses with the outstanding request before parsing their result.
const response = parseServerEnvelope(rawResponse, outstandingRequest.op);
const bytes = encodeFrame(response);
```

`ClientEnvelopeSchema`, `ServerEnvelopeSchema`, `SessionCommandSchema`,
`SessionSnapshotSchema`, `SessionEventSchema`, `InteractionSchema`,
`StoredEventRowSchema` and `StoredRequestRecordSchema` have corresponding public
types. `OperationSchemas`, `ResultSchemas`, `OperationParams<O>` and
`OperationResult<O>` provide typed operation-specific data. `SessionCommand`
describes the inner `{op,params}` command, not a second transport envelope.

Use the runtime parsers, not only `Value.Check` or TypeScript assignments.
`parseSchema` verifies bounded plain JSON, checks the schema, strips unknown
optional fields without mutating input or schemas and enforces UTF-8/encoded
field limits. Union validation selects direct matching branches without skipping
nested union limits. `JsonValueSchema` marks bounded extension data; its recursive JSON,
collection, prototype and byte checks run in the parser, not a cyclic TypeBox
schema. A standalone `Value.Check` is not sufficient for this boundary.
Specialized parsers additionally check aggregate and cross-field invariants.
`parseServerEnvelope` requires the outstanding operation for accepted responses:
the wire deliberately identifies the request using `re`, not a repeated `op`.
`parseOperationResult` validates a result independently. Schema validation cannot
infer which result belongs to an outstanding request.

Unknown operation/discriminator values are rejected. Unknown additive event
kinds are retained as bounded JSON and must advance the revision without
inventing known behavior. A malformed **known** change cannot fall through to
the unknown-change branch. A required new behavior needs explicit capability
negotiation or a new protocol version. Configuration is a closed, secret-free
allowlist using the existing 65 CLI option names plus scoped/default model and
thinking settings; config paths and credential fields are not extensible JSON.
The host still applies each setting's existing validation and reload rules.

## Operations and capabilities

`OPERATION_CATALOG` declares each operation's scope,
mutation, persistence category and eligible client kinds. `hello` negotiates
the actually available subset, interaction kinds and optional UI
capabilities;
catalog membership alone does not mean a handler exists or authorize its use.
Hello capability names and error codes accept bounded unknown strings for
forward compatibility. Clients ignore unsupported advertised operations; a
request using an unknown operation still fails validation. Optional response
fields, including additions to an empty result, are stripped before use.

`ERROR_CODES` exports the known codes, with `KnownErrorCode` as their literal
union: `invalid_request`, `unsupported_operation`, `protocol_mismatch`,
`unavailable`, `authentication_required`, `busy`, `request_conflict`, `stale_request`,
`expired`, `not_found`, `forbidden`, `already_resolved`, `storage_failure`,
`ownership_lost`, `resync_required`, `indeterminate`,
`request_capacity` and `target_mismatch`. `ProtocolError.code` remains a bounded
wire string so clients can handle future codes with a generic fallback.

- Host: `hello`, `host.status`, `sessions.list`,
  `sessions.create`, `session.import`, `host.stop`, `host.restart`, `host.logs`.
- Session binding/lifetime: `attach`, `detach`, `close`.
- Execution: `prompt`, `steer`, `follow_up`, `cancel`, `set_model`,
  `set_thinking`, `compact`, `fork`, `command.invoke`, `interaction.answer`,
  `ui.action`, `shell.execute`, `session.reload`.
- History/settings: `session.rename`, `session.tree`, `session.branch.select`,
  `session.entry.label`, `session.clone`, `session.export`, `session.delete`,
  `session.history`, `queue.update`, `config.get`, `config.set`.
- Child execution inspection/control: `executions.list`, `executions.read`,
  `executions.steer`, `executions.cancel`.
- Root-scoped process panel: `processes.list`, `processes.read`,
  `processes.write`, `processes.stop`. Resource IDs are authority references,
  never PIDs. Arbitrary process output/stdin/control bytes use canonical base64;
  offsets and read/write limits count decoded bytes.

Operation eligibility does not assign privileges to TUI, ACP or headless labels.
Clients negotiate the operations and UI vocabulary they implement; native TUI
components remain client-local. ACP requests strict session
policy explicitly. Client kinds only describe provenance. The authenticated
host assigns principals, origins, session bindings and resource/control
authority. `command.invoke` is for registered
extension/skill commands only; built-ins have their own typed operations.
Missing handlers reject explicitly. Detach is not cancel, close or host stop.

## Generic UI elements

The current generic vocabulary negotiates `ui.status`, `ui.progress`,
`ui.document`, `ui.view` and `ui.action`. Forms are negotiated solely through
the `form` interaction kind, not a separate UI capability. Forms declare typed
inputs and explicit submit/cancel actions. Views and documents carry complete
bounded data and revision-checked actions; `ui.action` identifies the element,
revision, action, optional item and submitted values. Optional hints may select
rendering but cannot change data, actions, validation or outcomes.

Elements carry plain-text fallbacks; document/view/progress actions are
declarative IDs bound to the current element revision and session through the
`ui.action` request. Forms use a bounded field vocabulary (string, boolean,
number, enum and multi-select), and the parser checks answers against declared
fields and choices. Documents reject raw HTML and non-HTTP(S) links; views
validate item fields and page limits. Renderer hints remain optional metadata
and do not grant eligibility or authority. Hosts must verify the current
element, session, revision and declared action through ordinary request
admission.

The optional `hello.capabilities` list describes UI vocabulary support only. It
cannot assert local-console status; the authenticated transport determines that
host property. An interaction's optional `authority` distinguishes `owner`
approval from `local-console` host consent. Hosts enforce current capabilities,
principal, attachment, scope and policy, including creator-affine host prompts. Existing-Chrome
approval is owner-session scoped; MCP sign-in and installation prompts require
local-console authority. Hosts must not infer either authority from client claims.

Interactions opt into drain/restart deferral with `deferrable: true`, independently
of their request kind. A later answer to a deferred session interaction starts a
continuation turn. Other pending interactions are cancelled. ACP clients request
strict policy explicitly with `requirePolicy: 'acp-strict'` on create, import or
attach; client kind does not select execution policy.

Only registered daemon sessions appear in `sessions.list` or can be resumed.
Pre-daemon transcripts remain untouched and invisible to session discovery.
Explicit `session.import` creates a new session ID from validated JSONL history;
`session.export` remains available. Every listed row carries a `revision`, so a
client can close a session and submit `session.delete` without restoring it.
After a stale revision rejection, list again before retrying.

Accepted `steer` and `follow_up` results are either `{itemId}` or
`{status: 'handled'}`, never both. These are unpublished-v1 corrections and remain
part of the first-release public-contract assessment.

`fork.from` selects from the source's complete stored user-message selector,
including inactive branches. `entry` uses its entry ID; `position` is its
zero-based selector index, not a paged-history offset. The new session branches
before that entry without changing the source, resubmitting text or switching
the client's attachment.

`config.set` uses locked, unconditional field merges: unrelated fields survive
and the last successful writer wins for the same field. It takes no revision.
The runtime parser rejects any own obsolete `params.expectedRevision` before
normalization and request identity, rather than silently discarding a CAS
expectation. Branch, label and deletion operations take no expected revision either.
The local host supports global configuration fields and model defaults, plus
session-scoped extension overrides. Session model/thinking changes use their
dedicated operations. Project configuration remains unavailable.

Story 1 explicitly defers targeted `queue.update`: the server rejects it as
unavailable and does not advertise it. Existing enqueue and faithful observation
remain supported; observation does not promise atomic editing or selection
notifications. This deferral requires no upstream SDK changes or private queue
workarounds. The schema remains reserved for a separately negotiated future
implementation.

Session and process list cursors are scope-bound keysets, not global-clock
snapshots. Unrelated activity does not invalidate them. Removal of the cursor's
ordering anchor or a different filter/root requires a fresh listing.

Removing configuration CAS corrects the unpublished initial v1 contract; no
version bump is made in this slice. This is not an exception to SemVer for
published/consumed packages: release readiness must inspect exports, behavior,
manifests and packed exact application dependencies before publication and use
the next minor if a released `0.x` contract is broken.

## Requests, retries and outcomes

Requests are `{v:1,id,op,session?,params}`. Accepted replies always have
`{v:1,re,outcome:'accepted',result}`; an empty result is `{}`. Rejected and
indeterminate replies carry a bounded typed error instead. A returned `runId`
means admitted/started, not completed.

Mutation IDs are UUIDv7. Other IDs remain opaque nonempty strings up to 128
UTF-8 bytes, including legacy Pi IDs. Request IDs have no freshness window.
`requestRetainUntil` retains records for seven days after the later of the
embedded timestamp and admission time. Normalize UUID spelling before lookup.

`canonicalRequestPayload` compares normalized semantic data, excluding `id` and
wire version. `compareRequestPayload` distinguishes same/conflict/unavailable;
it does not execute or retry anything. The host reserves request capacity before
effects, persists intent/outcome, and treats ambiguous dispatch as
`indeterminate`. Limits retain 100,000 records/session and 1,000,000/namespace,
with 1,024 reserved control slots. Never evict retryable records to make room.
Canonical payloads can approach the frame limit; the persistence layer must
budget retained bytes rather than assuming the request-count limit bounds disk
or memory usage. A digest-only identity needs an agreed stored-row contract;
it cannot silently replace this schema's canonical `payload` string.

## Environment and credentials

All sessions use the daemon's launch environment. There is no per-client capture,
per-session provisioning/refresh operation, environment handle or resume
re-provisioning requirement. Environment values do not belong in protocol
requests, snapshots, events, durable request identities or diagnostics.
Existing individual process-tool environment arguments are a separate feature;
this protocol does not remove them or add a replacement session-level API.

Credential-setting and OAuth workflows still use their private references and
existing locked credential stores; those references do not provision a session
environment. `StoredRequestRecord.payload` is the canonical command payload,
without an environment-specific alternate identity.

Validation cannot detect an arbitrary secret deliberately placed in normal user
text or extension JSON. Producers remain responsible for sanitizing diagnostic,
presentation and extension data. `encodeFrame` is a low-level JSON encoder, not
a secret scrubber; encode validated, authorized envelopes only.

## Snapshot and live cutover

Snapshots contain session/root/parent IDs, revision, active branch and pinned
history, model/thinking, queue IDs, run origin, catalogs, policy and blockers,
tools, interactions, children, processes and declarative presentation. No
environment metadata, callbacks or runtime objects.

At attach the host must atomically capture revision **and** every active stream's
complete prefix/end offset while installing the subscription. Send the snapshot
first, then revision R+1 and text only after the captured offsets. History cursors
are pinned to the captured view. Persist revision/state before fan-out.

Only assistant/thinking text is unrevisioned:
`{v:1,session,stream:{message,id,kind,offset},text}`. Offsets count Unicode code
points, not UTF-16 units or UTF-8 bytes. `classifyTextDelta` checks incoming deltas
against already-validated reducer prefixes without rescanning the prefix on
each append. Unknown streams return `start` at offset zero and `gap` otherwise;
callers explicitly mark `completed` or `completion_only` streams to ignore late
text. Prefix offsets must remain consistent as the reducer appends. The helper
also distinguishes exact duplicates and does not mutate a reducer. On a gap,
request **at most one** recovery snapshot per stream. Missing/over-limit prefixes
become `completionOnlyStreams` (`limit|lost`), with no fabricated text. Ignore
later deltas for that stream until the authoritative completed message replaces
its transients. Completed streams ignore late text only when the caller retains
that terminal identity.

Every other meaningful change is revisioned. `classifyRevision` distinguishes
next/duplicate/gap. Coalesce high-volume tool output/status into bounded
replacement `tool.updated`/`presentation.updated` changes **before** assigning
durable revisions; they are never text streams. Tool states include truncation
and completed/failed/interrupted status. Completed messages and tools replace
transients by stable IDs. Unrecoverable gaps/overflow return `resync_required`,
not fabricated revisions. `StoredEventRow` is transport-neutral control data,
not a new transcript store or execution replay log.

## Interactions and mismatch control

Interactions are data: scope, request kind/schema, authority, timestamps,
waiting/deferred/terminal state, responder and result. `validateInteractionAnswer`
checks kind, offered IDs and declared form fields/actions. The broker
must additionally enforce principal eligibility, expiry and atomic first-winner
semantics; persist the winner and continuation before notification. Disconnect
does not answer/cancel. Deferral without a prior timeout uses 30 minutes; live
nonserializable approval/OAuth operations require fresh requests after restart.

The separate `CONTROL_VERSION=1` grammar supports authenticated mismatch status
and drain/force stop/restart only. `BootstrapHelloSchema` extracts the
initial version mismatch from a full hello while stripping unknown fields;
`ControlResponseSchema` accepts positive advertised protocol versions and
additive fields and provides binary/protocol,
canonical roots, instance and lifecycle state. `ControlRequestSchema` rejects
session work and environment transfer. Attach and management
pin the complete namespace/instance/root identity; the host must verify it.
`DaemonTarget` selects production or an explicit isolated fixture namespace;
canonicalization, root containment, peer authentication and ownership are host
responsibilities, not filesystem functionality in this package.

## Remote commands and channel origins

Personal-host tokens carry `host.userId` and `felan.user_id`; team-host tokens
omit those fields. Hosts, not these schemas, enforce requester authorization.

Platform commands run with origin `{ kind: 'web', user, command }`. A claimed
`RemoteCommandRow` may omit `requester` and carry `automation: { source }` or
`channel: { provider }`. Automation commands use `{ kind: 'automation', source }`;
`AutomationSourceSchema` bounds a nonempty source to 256 UTF-8 bytes. Channel
commands use `{ kind: 'channel', provider, user?, command }` on runs, queue items
and messages. `ChannelProviderSchema` limits `provider` to
`^[a-z][a-z0-9_-]*$`, at most 64 bytes. Web origins still require `user`.

`RemoteOperationSchema` includes `follow_up` with `PromptSchema` params and the
same `{ itemId }` or `{ status: 'handled' }` result as local follow-ups. Remote
`sessions.create` accepts an optional lowercase UUID `sessionId`; supporting
hosts advertise `sessions.create.session-id` in `capabilities.features`.
Remote and local `sessions.create`
accept optional `instructions` (at most `LIMITS.instructionsBytes`, 16 KiB) that
the host appends to that root session's system prompt; child sessions do not
inherit them. A host advertises this with
`capabilities.features: ['sessions.create.instructions']`; `REMOTE_FEATURES`
lists the known values. Features are optional behaviours: platforms rely on one
only when the registered host advertises it, and readers ignore unknown values.

## Limits and verification

`LIMITS` is the authoritative numeric table: JSON depth 32, 64 KiB structured
data, 8 active streams/1 MiB each/4 MiB total, 64 KiB process reads/16 KiB
writes, 256-entry/12 MiB pages, 32 MiB unsent bytes, 64 in-flight requests and 16 KiB session instructions. The 64 KiB/1,024-entry structured JSON limits apply to
structured presentation data, tool catalog parameters and coalesced tool
status details, not transcript payloads. Transcript tool arguments, result
details and message details instead use the enclosing 12 MiB message/page/
snapshot budgets and depth 32; they are preserved without truncation, including
collections larger than 1,024 entries. The host enforces queue/backpressure, retention and socket
platform limits.

```sh
pnpm --filter @felan-ai/session-protocol build
pnpm --filter @felan-ai/session-protocol type-check
pnpm --filter @felan-ai/session-protocol test
```

The host's ownership, admission, persistence, registry, broker, reducer and
end-to-end convergence tests remain separate Story 1 gates. This package alone
does not implement a daemon or prove multi-process execution safety.
