# Story 1 integration contracts

Historical pre-services contracts. The profile API below is superseded by
[ADR 0036](../decisions/0036-configure-extension-services-through-trusted-providers.md)
and [the current service/UI guide](extension-services-and-ui.md). It is not a
current import or configuration reference.

Companion to the [handoff](session-daemon-implementation.md). These are the S1.01
baseline contracts for S1.02 and S1.05; they can be implemented independently.
Symbols and reserved paths below are proposed outputs, not existing APIs.
Changes affecting another task require an explicit recorded handoff.

Distribution amendment: [ADR 0025](../decisions/0025-separate-daemon-and-client-distributions.md)
and S1.07a split the daemon into `apps/daemon` (`@felan-ai/daemon`) and the
CLI/TUI clients into `apps/felan` (`@felan-ai/felan`). References below to
`apps/tui` paths describe the pre-split baseline. The public profile surface is
now `@felan-ai/daemon/daemon-profile`; the former client export is removed,
without a compatibility shim. Profile API version 1 and the runtime contracts
are unchanged. The daemon and protocol have intended initial 0.1.0 releases;
the client breaking export removal targets the prepared, unpublished 0.29.0
release. Publication still requires final manifest/packed assessment and the
new-package bootstrap/trusted-publisher procedure.

## Public protocol: `@felan-ai/session-protocol`

Initial version `0.1.0`, ESM, browser-compatible. No Node, Pi, Agent Core,
filesystem, ACP, platform or renderer imports. Use the existing `typebox@1.1.38`
schema style (for example, `ext-ask-user`), depending on it directly, not through
Pi or Agent Core. Include runtime validation, not just schemas. Export types and schemas
from `src/index.ts`; no daemon implementation in this package.

Reserve `src/{envelopes,commands,events,interactions,limits}.ts` and matching tests.
Public exports: `PROTOCOL_VERSION = 1`, `ROW_SCHEMA_VERSION = 1`, `LIMITS`,
`ClientEnvelopeSchema`, `ServerEnvelopeSchema`, `SessionCommandSchema`,
`SessionSnapshotSchema`, `SessionEventSchema`, `InteractionSchema`,
`StoredEventRowSchema`, plus their inferred types. Export `JsonValue` only for
bounded extension-defined payloads; built-in operations use discriminated types.

### Framing, handshake and identifiers

- UTF-8 JSON, one object per LF-terminated frame; escape embedded newlines.
  Reject invalid UTF-8, excess depth (>32), nonfinite numbers, malformed fields
  and oversized/incomplete frames before dispatch. No binary/JSON-RPC transport.
- Client request: `{v:1,id,op,session?,params}`. Server response:
  `{v:1,re:id,outcome:'accepted',result}` or
  `{v:1,re:id,outcome:'rejected'|'indeterminate',error:{code,message,retryable}}`.
  Events: `{v:1,session,rev,change}`. Streaming uses the separate shape below.
  An accepted command need not mean the run has completed; result names `runId`
  where applicable. Empty result is `{}`, not a missing outcome.
- Server assigns UUID session/run/message/interaction/attachment IDs. Treat all
  IDs as opaque strings, never filesystem paths. Existing Pi session IDs remain
  valid; validate nonempty length <=128, not a new incompatible UUID-only rule.
- Mutating request IDs are UUIDv7. IDs are not rejected for age or clock skew;
  terminal request records are retained for seven days after the later of
  admission and the ID's embedded timestamp. Admission bounds only in-flight
  work; at that bound reject new mutations with `request_capacity`, keeping a
  reserve for cancellation, interaction resolution, close and drain. Never evict
  still-retryable records. Queries use the same envelope.
- `hello` is first: client binary version, protocol 1, kind `tui|acp|headless`,
  supported interaction kinds and presenter `{id,version}` entries. Response
  assigns an attachment principal, daemon instance ID/version, namespace and
  canonical agent/root-set identity, and actually available operations. Client kind is cooperative
  same-user policy, not protection from malicious same-UID code.
- Authenticate the endpoint before accepting any operation. The request cannot
  supply its own authoritative principal or responder. Session target must be
  authorized against the connection's daemon-assigned bindings.
- Cross-build attachment requires a compatible wire protocol and authenticated
  target identity (see [ADR 0046](../decisions/0046-attach-clients-to-compatible-daemon-builds.md)).
  Manager package/version, provider selection and configuration differences never
  block attachment; absent composition metadata is allowed. Daemon version,
  manager package/version and provider digest differences produce a warning with
  the installed/running versions and `/restart`. The configuration digest is
  informational. Sessions keep using the daemon's build and configuration.
- Transparent refresh of a provably idle daemon is limited to an initial,
  launch-capable connection without an explicit expected daemon identity, and
  only when the daemon version differs. Composition differences alone never
  trigger replacement. Unknown active work is not proof of idleness. Established
  clients' automatic and manual reconnects never replace the daemon, even when
  idle, so they cannot undo another client's restart.
- Protocol and authenticated target identity mismatches remain blocking. Never
  automatically replace an incompatible-protocol daemon. Its fixed bootstrap
  response includes daemon version, supported protocol, root identity and state.
  The mismatch management grammar permits status and **explicit** restart/stop
  only, never session commands or automatic force. S1.03/14 own authentication
  and lifecycle; messages remain bounded by the bootstrap schema.
- `providerDigest` retains its host `restartRequired` meaning without restricting
  attachment. Older same-protocol daemons can accept clients regardless of
  provider selection or missing composition metadata.

Every client carries an explicit `DaemonTarget` into discovery, launch and
management; see [namespace contract](#production-and-isolated-runtime-targets).
Attach/stop/restart verify the expected namespace, canonical roots and live
instance ID. A path alone, stale readiness file or matching PID is not identity.

### Resource limits and compatibility

| Boundary | Initial limit |
| --- | --- |
| ID / command name / path | 128 / 128 / 4,096 UTF-8 bytes; paths reject NUL |
| Structured presentation | 64 KiB |
| Retained active text | <=1 MiB UTF-8 per stream, <=4 MiB total and <=8 streams per session; overflow uses completion-only state below |
| Process output read / input write | 64 KiB / 16 KiB decoded bytes per request; explicit base64 for arbitrary bytes |
| Snapshot/history page | Default 256 entries per page, no schema cap; opaque continuation cursor |
| Snapshot tools / processes / children | <=256 each via `trimSnapshotLists`: oldest finished first, then oldest running. Processes are ordered by last update. Clients trim live updates by the same rule and never resnapshot for list length |
| Snapshot interactions | Waiting or deferred only; clients drop an interaction when it resolves |
| Per-client unsent bytes / in-flight requests | 32 MiB / 64; overflow requires resnapshot or disconnect |
| Identifiers in one catalog/page | <=1,024; page larger lists |

All sessions use the daemon's launch environment. The user explicitly superseded
creating-client/per-session environment transfer for Story 1. There are no
provisioning handles, environment fields or environment-refresh operations.
Restart the daemon under the desired environment to change PATH, proxy or
provider variables. Never put endpoint/control credentials in the process
environment inherited by tools, or journal/log raw environment values.
Ordinary config commands still reject secret-valued fields; credential-setting
flows use existing locked credential stores, not secret-bearing durable requests.

POSIX endpoint length is a separate bound from general paths: at most 103 UTF-8
bytes on Darwin and 107 on Linux, excluding the NUL terminator. S1.03 validates
the actual platform limit and rejects an overlong path before bind. Use a short,
owner-private runtime directory; never silently move it to shared `/tmp` or TCP.
Windows pipe names use a conservative 240-character application limit and must
still pass native validation/DACL checks. Length probes are platform-specific,
not evidence that the other OS has been tested.

Command validation rejects unknown operation/discriminants. Additive optional
fields in a known version are tolerated but stripped before semantic payload
comparison; required execution semantics cannot hide in ignored fields. Readers
ignore unknown *event* kinds in additive versions while advancing their revision;
a new required behavior/capability must be negotiated, or bump the protocol.
Breaks to protocol/profile `0.x` public APIs require the next minor, not a patch.
TypeScript types alone are never input validation.

### Operation catalog

The table fixes names and required payload meaning, not an invitation to expose
all operations in ACP. Each mutating branch has an explicit schema and request-ID
record. Do not smuggle built-ins through an unrestricted generic `command.invoke`.

| Operation | Parameters / result and conditions |
| --- | --- |
| `hello`, `host.status` | Handshake above; composition reports manager, provider and configuration metadata for diagnostics, not attachment authorization. Status includes lifecycle, binary/root/protocol, active counts (`sessions`, `runs`, `work`, `attachments`; `work` counts everything a restart would interrupt) and setup needs, no secrets. |
| `sessions.list` | Optional cwd/root filter + cursor. Newest last activity first, then session ID; the cursor holds the last row's position, and malformed or foreign cursors return `resync_required`. Summaries include registered sessions and unregistered pre-daemon transcripts, with warm/evicted/closed, run state, title (session name), optional preview (first user message), model, last activity, policy state. Titles and previews are read only for the returned rows. Unused drafts are excluded (see ADR 0040). Read-only. |
| `sessions.create` | Absolute cwd, optional configured sessionDir, model/thinking/config overrides and validated explicit extension paths from local clients only. -> session ID. No creation source or per-session external-extension flag. Host settings apply to every new root; children inherit root paths. Only the creating TUI prompts for project trust; other creators load only already-trusted project folders. The root is a draft until its first user, assistant or shell message; a draft with no conversation is discarded when idle (ADR 0040). Resolve trust/setup before side effects; acquire actual-root locks first. See ADR 0043. |
| `attach` | Session ID; optional `requirePolicy:'acp-strict'` for ACP. -> attachment binding + snapshot. Unregistered IDs return `not_found`. Attaching to a registered busy session is allowed. |
| `detach` | Attachment ID -> remove only that binding. EOF is the same operation without a required ack. |
| `close` | Session ID -> settle the session's foreground work, child sessions and PTYs; retain history and independent detached-job records, then close. Detached jobs are not implicitly killed. Not ACP `session/close`, which maps to detach. |
| `prompt`, `steer`, `follow_up` | Text + typed text/image/resource attachments; origin assigned/validated by adapter. Prompt starts only while idle; steering/follow-up preserve Pi queue semantics. Rejected busy gives retryable typed error, never silently forks. |
| `cancel` | Run ID (optional current-run selector resolved under admission) -> abort that run's active foreground operation and related waits. Already-spawned child sessions and detached jobs require their existing explicit cancellation/stop operations; see the lifetime table in the baseline. Does not delete session or detach other clients. |
| `set_model`, `set_thinking` | Provider/model ID or thinking enum `off|minimal|low|medium|high|xhigh|max`; validated against session model scope. Accepted during an active run, as in Pi. |
| `compact`, `fork` | Compact instructions/method; fork from source entry ID/position. Fork allocates a **new** registry entry and returns its ID, preserving the source and its attachments. Inherit policy, env and bounded resource context. |
| `command.invoke` | Catalog command name + text arguments for registered extension commands only. Execute in daemon. Missing/unsupported handler is an explicit rejection. |
| `interaction.answer` | Interaction ID + typed answer or explicit user cancellation. Broker validates eligibility, schema, timeout and terminal state; first valid answer wins. |
| `session.rename`, `session.tree`, `session.branch.select`, `session.entry.label` | Name; paged tree query; entry ID + optional summarization; entry ID + label. Serialized without expected-revision checks and published to all clients. |
| `session.clone`, `session.import`, `session.export`, `session.delete` | Clone -> new ID; import a validated owned copy of a selected local file into a new managed session with fresh ID (the source must start with a session header); export format `html|jsonl` and explicit owner-approved destination; delete closes the session if needed and removes it after one client-side confirmation, never implicit on close. Imported history is data, not execution. |
| `session.history`, `queue.clear`, `queue.update` | Pinned history cursor. `queue.clear` atomically restores all queued text through Pi's public `clearQueue()` as `{steering, followUp}` (native before daemon-held input per kind; attachments dropped), rejecting oversized results before clearing. Manual-compaction input is daemon-held, then delivered in the same run. Targeted `queue.update` remains unavailable and unadvertised. |
| `shell.execute` | Command + `includeInContext:boolean` preserves `!`/`!!`; daemon runtime only, admission/policy and process tracking apply. No client shell used for agent work. |
| `config.get`, `config.set`, `session.reload` | Core execution values plus generic `extensionConfig.<id>.<field>`, validated against declared fields by the host configuration provider. `config.get` includes a required `writable` boolean for the requested scope; both client and extension persistent writes use that provider. Session overrides remain writable independently of persistent scopes. No presentation preferences or extension-specific protocol keys. Explicit reload only. Process-level proxy/environment changes require daemon restart. No arbitrary config path/value bypass. New sessions read current files; live sessions do not auto-reload. |
| `processes.list`, `processes.read`, `processes.write`, `processes.stop` | Root-scoped resource ID, cursor+byte limit, base64 input, signal `SIGTERM|SIGKILL` respectively; checked root lineage and control ownership. Never accept PID as authority. Read result includes offset/running/exit/missing state. |
| `host.stop`, `host.restart`, `host.logs` | Explicit drain or force policy; bounded sanitized log cursor. No terminal disconnect invokes them. Only status/stop/restart are available through authenticated protocol-mismatch bootstrap; logs require v1. |

Trust/dependency/OAuth/login actions are typed broker requests or schema-bound
host commands in S1.09/12/14, never arbitrary shell/config access. Operation capabilities are negotiated without client-kind gates. Existing TUI share,
bug-report, clipboard and external-editor actions stay explicit client workflows;
they do not justify platform/telemetry implementation or new ACP capabilities.

Error codes include `invalid_request`, `unsupported_operation`,
`protocol_mismatch`, `unavailable`, `authentication_required`, `busy`,
`request_conflict`, `stale_request` (undeclared or stale UI actions), `expired`, `not_found`, `forbidden`,
`already_resolved`, `storage_failure`, `ownership_lost`, `resync_required` and
`indeterminate`, plus `request_capacity` and `target_mismatch`. Error text is bounded and sanitized.
Reject before effects.

### Snapshot, streaming and durability

`SessionSnapshot` has session/root/parent IDs, revision, active branch, paged
transcript tail/cursor, model/thinking, queue item IDs, run/turn origin, tools and
command catalog, effective policy, pending interactions, children,
processes, declarative presentation state and bounded `activeStreams` entries
`{message,id,kind:'assistant'|'thinking',text,offset}`. `text` is the complete
retained prefix and `offset` is its end in Unicode code points, not a tail with
a fabricated prefix. No Pi objects, callbacks, raw
environment, credentials or executable history. Session state is
`open|closed`; residency `warm|evicted`; run state
`idle|running|waiting|cancelling|interrupted`; host state
`starting|ready|draining|stopped|blocked`. Do not conflate them.

At attach, atomically capture revision R **and each active stream's prefix/end
offset** with subscription installation. Send that snapshot before revisioned
events R+1 and text deltas after those captured offsets; discard pre-cutover
deltas already represented in the snapshot. This cutover must account for
unrevisioned text, not only R. Historical pages are pinned to the
snapshot/branch cursor; invalidate and resnapshot if the underlying view cannot
be retained. Buffer overflow/gap gives `resync_required`, not fabricated events.
Completed messages/tools replace transient projections by stable IDs.

If a complete active prefix exceeds the limits or was lost, return its identity
in `completionOnlyStreams` with reason `limit|lost`; omit partial text and show
"waiting for completed message". Continue other state/revision updates, but
ignore later deltas for that stream until the authoritative completed message.
On a stream gap, the client requests at most one recovery snapshot per stream
ID; use its exact prefix if recoverable, otherwise enter completion-only mode.
Do not repeatedly resnapshot an irrecoverable stream or invent missing text.
The server marks an overflowed stream completion-only for its remaining lifetime.

Revisioned change kinds include message completion, coalesced tool start/output/
completion, run/queue, interaction requested/resolved, metadata/model/thinking,
policy, child/process and presentation changes. Only text streams are unrevisioned:
`{v:1,session,stream:{message,id,kind:'assistant'|'thinking',offset},text}`.
Offsets count Unicode code points, not UTF-8 bytes or UTF-16 code units. Each
stream starts at zero; a completed message supersedes all its streams. Gap,
duplicate, astral-character and late-stream tests are mandatory. Loss of a text
delta must not lose the completed message. Coalesce high-volume tool/status
updates before durable revision assignment; do not label them text streams.

`StoredEventRow` is transport-neutral `{schemaVersion:1,session,rev,change}`.
It fixes future row semantics, not a SQL schema or platform outbox. Local storage
retains revision high-water + bounded projections and uses Pi's transcript/tree
as content authority; it need not duplicate the complete transcript event log.
Persist revision/state before fan-out. A Pi message-end/control dual-write gap is
reconciled conservatively with stable entry/message IDs, never by rerunning the
model. Recovery never regresses revision or presents missing state as completed.

## Public profile seam: `@felan-ai/daemon/daemon-profile`

S1.05's contract now lives at `apps/daemon/src/daemon/profile.ts`, emitted as
`dist/daemon/profile.*` after the S1.07a package move.
This subpath exports **types only** plus `DAEMON_PROFILE_API_VERSION = 1`.
The local implementation remains internal in `daemon/local-profile.ts`.
The app package may depend on Agent Core and extensions; protocol never does.
The daemon owns the `./daemon-profile` manifest export and its emitted files.
The client resolves the installed daemon package rather than a checkout path.
Profile types come through `@felan-ai/agent-core`; S1.05 adds any necessary
type-only core re-export (including `AgentSessionRuntime`) rather than importing
the pinned Pi API directly from a new public contract.
No cloud implementation, runtime plugin discovery, dependency injection container
or generic backend framework is needed.

Reserve these names and responsibilities:

```ts
interface DaemonProfile {
  readonly apiVersion: 1;
  readonly id: string;
  resolveResources(request: ProfileResourceRequest): Promise<ProfileResources>;
  openSession(request: ProfileOpenRequest): Promise<ProfileSessionBinding>;
  dispose(): Promise<void>;
}
```

- `DaemonProfile`: `apiVersion`, `id`, `resolveResources(request)`,
  `openSession(request)`, `dispose()`. `id` is `local` for Story 1.
- `ProfileResourceRequest`: absolute `cwd`, optional requested `sessionDir`.
  `resolveResources` is read-only and returns `ProfileResources`: canonical
  `agentDir`, effective `sessionDir`, `sessionStorageBase`, `agentStorageRoot`,
  `subagentRoot`, `memoryRoot`, plus `writableRoots`. Resolve configuration and
  symlink ancestors before creating/opening stores; lock acquisition is external.
  `sessionStorageBase` is `agentDir/storage/sessions`; the concrete root-session
  storage directory is derived only after the session ID is known.
- `ProfileOpenRequest`: resolved resources + verified ownership handle,
  `SessionExecutionPolicy`, `DaemonSessionServices`, and a
  discriminated target `new|resume|fork|clone|import`. Resume names the validated
  local session file. Fork names a source entry and explicit `before|at` position;
  `before` requires a user-message entry, while `at` permits any existing entry.
  Clone names the source session file. Import names a validated source copy
  already inside the owned session directory; the import host must
  stage external files under ownership before calling the profile. Import does
  not grant arbitrary external-file access. The profile creates/opens Pi SessionManager
  **only after** ownership validation. New IDs are returned, never assumed by the
  caller. Resume/fork retain the canonical persisted cwd and reject mismatched
  resources before side effects. Clone/import deliberately use the requested
  target cwd. No raw path sent by a client bypasses resource resolution.
- `ProfileOwnership.assertOwned(resources, target)` receives the canonical source
  path/ID, operation kind and destination directory. Before this idempotent check
  returns, the registry must hold the applicable source read/write claim and
  destination-directory ownership. Writable target ownership remains for the
  binding's lifetime; a read-only copy-source claim is needed only during open. The
  profile does not implement a second registry or its own single-writer lock.
- `ProfileSessionBinding`: `runtime: AgentSessionRuntime`,
  `agentRuntime: AgentRuntime`, resolved session/root/parent IDs and resources,
  diagnostics and tool-provenance catalog. Disposal uses `runtime.dispose()` only
  after registry-owned work is settled; it must not dispose shared daemon services.
  The binding has fixed session/root identity. Its `newSession`, `switchSession`,
  `fork` and `importFromJsonl` methods reject before effects: registry lifecycle
  must open a new binding through the profile. Root storage uses that root's ID;
  children must explicitly carry their parent's root ID.
  The post-bind `tools` catalog records actual tool source metadata and definition
  identities. Only recognized built-ins with an unchanged definition and a name
  in the shared safe-tool catalog are exempt from strict approval. Replacements
  lose that exemption until a fresh binding captures trusted provenance.
  S1.06 owns authoritative projection, revisions, registry and lifecycle.
- `DaemonSessionServices`: effective policy reader plus required
  `extensions.configuration(packages)` and `extensions.bind(context)` ports.
  S1.06/S1.09 implement broker, child/process and feature hosts behind this binding
  port; no transport or terminal types are required. The context carries the
  resolved configs/effective overrides, model scope, skill paths, classifier and
  dynamic-thinking decision already computed by the profile. The result supplies
  execution extensions, optional trusted-root paths/Codex wrapper/usage reporter,
  optional session/UI binding and required per-session cleanup. Missing required
  bindings reject rather than silently disabling a feature or approving it.
- All sessions and descendants share the fixed daemon launch environment. No
  per-session environment object or accessor is part of the profile contract.
  Per-session model/config/extension-registration views remain independent,
  while standard credentials refresh under their existing file locks.
- `SessionExecutionPolicy`: `host-default|acp-strict`,
  monotonic generation and trusted tool provenance. No per-turn privilege switch.
  The daemon assigns origin independently for display/audit.

Do not export local filesystem implementation classes or widen Agent Core with
daemon/profile/store APIs. No new environment accessor or HostAgentRuntime
base-environment option is needed for Story 1. Keep ordinary provider and
credential-command behavior, using the fixed daemon environment and daemon cwd
for credential commands where Pi does not expose a cwd input. Tools still use
their session runtime's explicit cwd; never call process.chdir per session.

Initialize PI_* host settings and the HTTP proxy dispatcher once at daemon
startup, before sessions/providers. Runtime settings changes to `httpProxy` or `httpIdleTimeoutMs`
require a restart, not reconfiguration of the global dispatcher. Keep endpoint
and control-token material out of tool environments. Do not log raw environment,
credential headers or command-credential output.
Malformed local settings and invalid HTTP settings produce warnings with safe
defaults, as in the existing host. Failed startup attempts are retryable; only a
successful initialization fixes the process configuration. The legacy in-process
TUI/headless application keeps its current lifecycle until the daemon cutover.

Historical note: the original design required creating-client environments and
an authoritative `getEnv` accessor. Pinned Pi's ambient auth/SDK/proxy/command
paths prevented that guarantee through a small wrapper. The user explicitly
selected a shared launch environment instead; no Pi patch, worker or provider
replacement is required. This does not make in-process extensions a sandbox:
trusted extension code can access process state and sibling data.

## Store and environment ownership

### Production and isolated runtime targets

`DaemonTarget` is a discriminated host/client input, never inferred from `CI`,
`NODE_ENV`, cwd or `FELAN_AGENT_DIR`:

- `{kind:'production'}` selects the one account-wide production namespace.
- `{kind:'isolated',runtimeDir,fixtureRoot}` explicitly selects a private test/CI
  namespace. Both are canonical absolute directories; all writable store roots
  must be inside this declared disposable fixture root. Reject production/default
  roots and symlink escapes. Derive namespace identity from the canonical runtime
  directory, not an ambient variable or a caller-chosen production alias.

The planned Story 1 CLI selector is `--daemon-runtime <absolute-directory>` for
an isolated target; it does **not exist at the baseline**. S1.14 adds/wires it for
all entrypoints. The selected directory is the fixture root, containing its
private `runtime/` and `agent/` subdirectories; do not inherit production agentDir
defaults. Explicit custom stores must still be inside that fixture root.
Test/CI wrappers
must require an isolated target, supply it on every invocation and refuse to
invoke launch/attach/stop without it. Programmatic test APIs have no production
default. Ordinary production use still selects exactly one user daemon.

Authenticated readiness/hello returns `{namespaceId,instanceId,agentDir,rootSet}`.
Pin these canonical values in the client/CI launch receipt. Attach, stop and
restart carry the expected tuple; a different namespace, agent directory or
instance returns `target_mismatch`, not a fallback to production. `rootSet` is
informational: a daemon adds custom session directories to its roots when a
session first opens there, so clients do not compare it. A restart issues a new instance
receipt. Tests may stop only their pinned isolated instance; process cleanup by
name/PID alone or unqualified `felan daemon stop` is forbidden in test harnesses.

Namespace locks separate production from isolated test daemons, **not stores**.
The canonical-root claim ledger and root lifetime locks are account-wide across
all namespaces, under a separate short-lived claim-coordination lock rather
than the production daemon's lifetime singleton. Sharing/overlapping an actual
root is rejected even across isolated namespaces. This is a testing exception,
not support for multiple production daemons.

Lock the production account-wide singleton independently of `FELAN_AGENT_DIR`, then the
canonical `agentDir`, which covers its default sessions, storage, subagent and
memory directories. A custom `sessionDir` (CLI or settings) is locked when a
session first opens there and recorded in `agentDir/daemon-store-roots.json` so
persisted sessions stay addressable after restart. A parent's lock covers
descendants within that owner, but overlapping roots or aliases held by another
live daemon conflict; detect ancestors as well as exact strings. Ledger claims
whose lifetime lock is no longer held are stale and discarded; an unreadable
ledger is rebuilt. Store roots need not be owner-only and may be on any
filesystem; only the runtime directory, socket and claim coordinator stay
owner-only. Keep the canonical-root claim ledger in the account coordination
directory, not under a selectable agentDir or isolated namespace. Keep lifetime
kernel locks and stable inode/file identity; never unlink a lock to unlock it.
Observe identity replacement and stop admission on loss. A lease timeout/PID
alone is not proof that a paused process or unfenced child has stopped.

The environment belongs to the daemon process, not to an attachment, session or
runtime residency. Detach and idle eviction therefore do not change it. Forks,
clones and children use the same launch environment. Restart uses the new
process's launch environment and reloads standard credential files under their
existing locks; there is no local-client reprovisioning gate or implicit attach
transfer. Environment values and derived credentials are never durable control
state or model-visible events.

## ACP policy transition and interaction contract

ACP-created sessions start `acp-strict`. Attaching with
`requirePolicy:'acp-strict'` attaches and replays immediately, even busy, and
tightens the open root tree to strict policy at once; there is no pending state.
Running tool calls keep the approvals they already had; later tool calls use the
new policy. When the last ACP attachment in the tree detaches, the tree relaxes
to `host-default`. Restore/fork/clone/child inherit the current policy.

Move the safe-tool list from `acp/interactions.ts` to daemon policy without
broadening it. A safe name is exempt only if the registered implementation has
trusted built-in provenance; an external replacement called `read` is not safe.
Unsafe tools generate broker approvals before effects. Any eligible attached TUI
may answer; ACP uses existing requestPermission/elicitation translations. Editor
EOF only withdraws that responder; no deny-and-abort and no approval-by-absence.

### Pre-daemon session files

Unregistered pre-daemon Pi transcripts in owned store roots are listed and
adopted in place on attach: their ID and file are kept, and new entries append to
the original file, immediately and without a quiet window, like 0.28.3 resume. The store
is not migrated as a whole and nothing is scanned outside listing and attach. An
explicit `session.import` still creates a new session ID from validated JSONL
history; `session.export` remains available.

An `Interaction` includes ID, host/session/root scope, kind/schema, authority, creation/expiry, `waiting|deferred|answered|cancelled|expired`, responder and
terminal result. Arbitrary component closures are never serialized. Ask-user
waits through detach, honors explicit timeout and defers on drain/release; default
expiry becomes 30 minutes on deferral if no timeout was specified. Persist winner
and one continuation before notification. Recovery dispatches only a proven
undispatched continuation; an ambiguous dispatch stays indeterminate. Tool
approval/OAuth with nonserializable live execution cannot be replayed as a user
prompt: cancel the interrupted operation on drain/restart, retain its visible
outcome and require a fresh explicit request; never silently autoapprove/retry.
