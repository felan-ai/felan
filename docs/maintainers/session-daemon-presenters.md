# Extension execution and client presentation

Extensions publish portable behavior through core services and `pi.ui`.
The daemon owns admission, canonical state and lifecycle; clients render the
same forms, documents, views, progress and statuses. See
[Services and generic UI](extension-services-and-ui.md) for the contract.

## Client boundary

- Built-in terminal renderers live in `apps/felan/src/tui/renderers`, not
  extension `./tui` entrypoints. Extensions do not export terminal adapters.
- `UiHintRenderers` is a client-local enhancement registry, not a daemon
  interaction contract registry. Hints may change layout, never fields,
  actions, data or authorization. Unknown hints retain generic rendering.
- `ClientInteractionPresenters` renders typed broker interactions, including
  generic forms. UI actions retain stable element, revision, action and item
  identity. Clients cannot fabricate an undeclared action or hidden payload.
- Client capabilities determine interactive support. Equivalent capabilities
  have equivalent semantics in TUI and ACP; client kind grants no privilege.
- Historical prompt insertion only replaces local editor text and never
  submits a model turn.

## Built-in service composition

| Extensions | Core services and presentation |
| --- | --- |
| Ask User, Prewalk, Tasks, Background Bash, Context View | Runtime/configuration and generic `pi.ui`; no feature-specific service wiring. |
| Subagents | Required Sessions service for ordinary child executions; client navigation uses `executions.list/read/steer/cancel`. |
| Prompt History, Insights | Required Sessions History service; generic query, paging and document actions. |
| Memory | Required Runtime, Models and Sessions; optional host worker/lifetime services for restricted dreaming and settlement. |
| Fusion, Model Tools, Session Title | Optional Models service; explicit unavailable behavior when required model operations cannot run. |
| Powerline | Optional Models, Usage and Sessions; generic values in every mode, optional client footer. |
| MCP | Required Secrets and optional OAuth Callback; protocol operations stay extension-owned. |
| Browser | Optional Browser Authorization; generic forms with provider-enforced host policy. |
| Felan API | Optional Felan Platform access; no feature-specific client contract. |
| MarkItDown, RTK, Codebase Memory | Optional Runtime Dependencies for explicit installation; existing binaries remain usable without installation support. |
| Context, Output Style, Codex, Session Compaction, Web Access | Portable runtime/configuration behavior; client-owned tool/message rendering where needed. |

## Agent and message display

The agent navigator consumes scoped execution records and actual child
attachments, not synthetic `AgentSession` objects. Steering and cancellation
use admitted `executions.*` operations; there are no `agents.*` operations.
The client preserves selection and disclosure across updates and joins its
owned attachment cleanup. Optional native navigation cannot alter execution
scope or admit a child itself.

Assistant display facts and tool-result names use validated message metadata.
Client rendering does not invent model names, usage or tool names. Unknown
tools use generic rendering; no execution function is transported to a client.

## Verification

Run daemon/client tests through `scripts/test-isolated.sh`, including the full
`scripts/test-isolated.sh pnpm verify` gate. Test with hints removed, equivalent
TUI/ACP capabilities, stale or foreign actions, reconnect, cancellation and
shutdown. Package checks must reject removed extension TUI/view entries and
private daemon exports. Passing tests do not establish npm publication or
trusted-publisher setup; follow [Releasing](releasing.md).
