# Extension execution and presentation split

This is the completed Story 1 execution/presentation boundary. Built-in
execution runs in the daemon and client screens render negotiated presentation.
It does not describe cloud/platform Stories 2–4.

## Foundation

- `apps/daemon/src/daemon/extension-ui.ts` translates primitive dialogs through
  the durable broker and emits bounded declarative presentation. Startup state
  is buffered until the registry can publish it. Opaque component factories,
  terminal hooks and renderer objects are not transported or executed there.
- Commands execute in the daemon. Their serializable catalog supplies client
  autocomplete; invocation and any resulting dialog use the protocol. The
  integration test exercises an actual registered command and its bound UI.
- `apps/felan/src/client/presenters.ts` maps typed dialogs to client UI, keeps
  choice IDs distinct from display text, and validates answers. It is an
  explicit renderer import, not part of the transport/reducer barrel. Its UI
  adapter must respect abort/deadline options and preserve input prefills.
- `@felan-ai/ext-ask-user/tui` exposes `createTuiAskUserPresenter` with UI, signal
  and optional progress only. The legacy host wrapper remains available; the
  daemon injects `AskUserHost` without loading this renderer.
- Custom dialogs require a daemon-registered exact presenter version and an
  eligible client advertising that version when the dialog is created. A
  missing renderer produces `unsupported`, not an implicit approval or an
  orphaned new dialog. Existing dialogs survive disconnect. Registration is
  fixed for a broker lifetime; the runtime-state renderer is a separate,
  reserved data contract.

## Package migration map

The [baseline inventory](session-daemon-inventory.md) lists the complete tools,
commands and shortcuts. These batches retain that inventory; composition work
in later steps must not drop an existing feature.

| Package | Batch | Execution / presentation boundary |
| --- | --- | --- |
| `ext-ask-user` | A: implemented | Broker host / package TUI wizard and typed client answers. |
| `ext-prewalk` | B: implemented | Same-session planning / typed broker plan review; retained entry and review policies. |
| `ext-fusion` | B: implemented | Model orchestration and saved lineup remain daemon-owned; `./tui` renders validated broker decisions and model choices, including cancellable retries. |
| `ext-mcp` | B: implemented | OAuth token store and callback remain daemon-owned; transient local-TUI provisioning remains pending through token exchange and is cancelled on disconnect. |
| `ext-browser` | B: implemented | Runtime and Chrome lease remain daemon-owned; host-scoped consent and client setup preserve local-only eligibility and post-setup verification. |
| `ext-subagents` | C: implemented | Registry-backed host / scoped agent catalog, controls and real child attachments; client-owned navigator, tool renderers and completion display. Original user changes are preserved. |
| `ext-tasks` | C: implemented | Daemon-owned root graph / explicit TUI host, coherent bounded view pages, live updates and read-only detail navigation across reconnect. |
| `ext-background-bash` | C: implemented | Daemon-owned jobs and PTYs / bounded process pages and output chunks; typed, generation-bound controls, current-job rechecks and reconnect restoration. |
| `ext-memory` | C: implemented | Daemon coordinator and bounded retained-history reader / typed chunked catalog and transcript, original picker controls, status, explicit processing and cold-reconnect recovery. |
| `ext-context-view` | C: implemented | Daemon-owned measurements / bounded read-only report and explicit client overlay; eight-row previews retain total counts, unknown windows and reconnect state. |
| `ext-powerline` | C: implemented | A compatible attached TUI enables daemon-owned usage, savings and coalesced Git data. Bounded semantic lines feed the unchanged client footer renderer; last detach stops and joins refresh work. Agent-rail data is covered by the subagent row. |
| `ext-prompt-history` | C: implemented | Daemon-owned scoped fuzzy search / original inline or overlay picker, live progress, typed query and selection, and full selected-text transfer before client editor replacement. |
| `ext-felan-api` | D: audited | Existing explicit requests and generic structured tool results; no platform connector or new authority. |
| `ext-model-tools` | D: audited | Injected model execution / generic structured results and preserved image blocks. |
| `ext-web-access` | D: audited | Existing network and conversion policy / bounded generic data results. |
| `ext-codex` | D: implemented | The daemon imports `./runtime` for provider-specific tool replacement and transport; `./tui` exports the unchanged patch-call renderer. The root entrypoint retains its legacy rendered tools. |
| `ext-session-compaction` | D: implemented | Compaction and recall stay runtime-owned; projected progress and bounded method/token metadata feed the client-owned collapsed/expanded summary renderer. |
| `ext-rtk-optimizer` | D: audited | Guarded optimization and explicit install command remain runtime-owned; notifications/status use the declarative bridge. Startup onboarding remains client-owned in S1.12. |
| `ext-codebase-memory` | D: implemented | `./runtime` owns indexing, leases and explicit confirmed install; `./tui` owns curated, direct and proxy tool rendering. Notifications/status use the bridge; startup onboarding remains client-owned. |
| `ext-markitdown` | D: audited | Converter, cache and explicit install command remain runtime-owned; status and diagnostics use the bridge. No implicit installation; startup onboarding remains client-owned in S1.12. |
| `ext-context` | D: audited | Scoped instruction discovery remains runtime-owned; status and command notifications use the existing declarative bridge. |
| `ext-insights` | D: implemented | Analysis and report storage remain daemon-owned; host-scoped local-TUI confirmation opens the validated report. Cancelling preserves it; `--no-open` does not request presentation. |
| `ext-output-style` | D: audited | Configured instructions and savings events remain daemon-side; settings use the existing configuration contract. |
| `ext-session-title` | D: implemented | Daemon eligibility uses the admitted root run's TUI origin, not Pi's RPC mode. Generation stays daemon-owned; projected metadata feeds the pure client title formatter. |

The optional bundled llama.cpp provider belongs to B but is not a 25th package.
Preserve its explicit interactive-root registration and model-management flow.
Its owned daemon adapter uses Pi's provider/client leaf modules, not the mixed
extension or private UI. The initial broker adapter uses paginated model
selection, explicit search queries and cancellable progress dialogs; S1.12 must
restore rich single-screen continuity. This is not client-cutover or exact UI
parity approval.
Host-owned tools/settings, trust/onboarding, thinking groups, tool activity,
startup/header/themes and completion renderers also require their existing
client or daemon owner; the package table does not replace that inventory.

### Agent navigator data boundary

The client navigator now accepts either the legacy local host or a data-only
`AgentNavigatorHost`. Data projections contain actual message/model/usage fields,
not an `AgentSession` facade. The existing rail, keyboard controls, grouped tools
and transcript rendering stay client-owned. Live projection updates retain
selection, scroll position and thinking/tool disclosure; changing the selected
agent resets transcript scrolling. Pending controls are serialized and transport
failures remain visible without clearing a steering draft.

The portable `ext-subagents/view` surface contains display and open-view
contracts. Agent records use paged `agents.list` and `agents.read`; steering and
cancellation use advertised, session-scoped `agents.steer` and `agents.cancel`.
The existing parent-bound subagent host remains authoritative, including while
the parent model is running. Cancellation uses safety admission. Accepted
control responses contain the host's explicit success or domain-error result.

The registry publishes a bounded catalog-generation signal, not repeated
transcripts. The client uses real child attachments and bounded history recovery,
preserves attachments owned by another consumer, and joins its own cleanup.
The agents command asks a negotiated presenter to mount the navigator and is
acknowledged on mount, not on closing it. Client shortcuts can open the navigator
without starting a model turn. See [ADR 0027](../decisions/0027-expose-scoped-subagent-view-and-controls.md).
These adapters are exercised by the isolated suite; S1.11/S1.14 still install
them in the final clients/composition. No shipping client-cutover claim follows yet.

`createClientAgentViews` accepts an optional client-owned tool-presentation
resolver. S1.11 supplies the built-in `./tui` renderers through it; only
`renderCall`, `renderResult` and `renderShell` are consumed. No execution function
is transported or installed by a transcript. Full tool mode uses those renderers
directly; grouped mode retains activity grouping and the existing `ask_user`
renderer exception. Without a matching renderer, the read-only generic display
remains available. Legacy local-session rendering is unchanged.

Assistant display facts (timestamp, provider/API/model, usage and stop reason)
and tool-result names use the reserved `details.felanMessage` namespace. Existing
object details keep their other fields; scalar and array tool details remain
unchanged and use the generic rendering fallback. Current assistant metadata
also uses the bounded, read-only `felan.message-display@1` presentation until its
completed message is committed. Text tokens still use the existing stream and
do not create per-token durable metadata writes. Client conversion requires real
metadata; it never invents a model, usage counts or a tool name. These additions
reuse existing JSON fields and do not add operations or execution semantics.

## Verification and release boundary

Keep import-boundary tests for both directions and wire tests for negotiated
versions, unsupported presentation, stable choice identity, reconnect and
command execution. Use the approved isolated runner for application tests.
The protocol presentation additions and exported presenter APIs require the
final S1.16 version/packed-dependency assessment; current manifests are not a
release approval.
