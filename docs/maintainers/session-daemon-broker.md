# Daemon interaction broker

`InteractionBroker` owns pending questions, tool approvals and host setup prompts. Session interactions are committed before publication. The first valid answer atomically records the winner; duplicate requests use the server's existing durable admission path. Detaching a client does not answer or cancel an ordinary question.

## Composition

Create the broker with `createRegistryInteractionBroker(registry)` and pass it to `SessionServer`. The server supplies negotiated client capabilities and actual session bindings, rather than accepting binding claims in answer payloads. Extension composition consumes `askUserHost()` and `approvalExtension(registry)`; the latter delegates safe-tool decisions to the profile's provenance-aware catalog.

The later extension/client cutover and daemon entrypoint tasks install these adapters into the complete application. The broker does not introduce another runtime, storage system or scheduler.

## Lifetime and recovery

- With no explicit timeout, a question can wait across detach/reconnect.
- Drain defers pending ask-user questions, using the existing 30-minute default expiry. Other pending operations are cancelled.
- An answer to a deferred question records a unique continuation together with the answer. Crash recovery never automatically replays a continuation: dispatched work is indeterminate, and a new explicit request is required. Dispatch intent remains durable before registry execution.
- A busy preflight leaves the continuation ready for a later explicit recovery attempt. Continuations for the same session are serialized.
- Abort and timeout produce explicit terminal outcomes. Settle the broker and registry before closing the control store or releasing ownership.

## Client policy

Session answers require a current attachment, an eligible client kind and negotiated interaction support. Host trust/dependency prompts are local-TUI-only. These are cooperative policies for authenticated same-UID clients, not isolation from arbitrary code running as that OS user.

Host prompts and transient OAuth presentation use out-of-band interaction notifications. OAuth remains local-TUI-only; URLs and transient credentials never enter the control snapshot. Losing the last eligible OAuth presenter cancels that operation. Clients clear notification state on transport loss; pending host prompts are replayed after the next verified handshake.

Custom interactions are disabled by default. Trusted daemon composition can pass exact `{ id, version }` contracts to `createRegistryInteractionBroker(registry, { presenters })`; a client's advertised renderer does not register a daemon contract. Unknown versions, or creation without a compatible eligible attachment, return `unsupported` before persistence. Recovery cancels pending contracts that are no longer registered. Once created, a custom question retains the ordinary reconnect lifetime; detaching its presenter does not silently cancel it. Answers still require an eligible attachment with the exact negotiated presenter version.

The runtime UI-state renderer (`felan.runtime-ui`) is negotiated separately from custom questions and cannot be registered as an interactive presenter. Registration is fixed for a broker's lifetime; changing the installed contracts requires new composition, not mutation of a connected client's capabilities.

Registered contracts may supply a synchronous answer validator. It runs before
the answer is committed, so an invalid action does not consume the question.
Only identity/version metadata is sent to clients; validators stay in the
daemon. The built-in Prewalk contract uses this boundary for its review actions.

Custom requests can carry a separate optional JSON `document` field within the
existing 256 KiB interaction ceiling. JSON metadata and answers retain their
64 KiB limits. This preserves the full 32,000-character Prewalk plan, including
Unicode and escaped controls, and existing bounded Fusion reviews without
double-encoding their JSON, without widening unrelated structured data. The
client validates feedback before closing its editor.

The notification envelope is a public protocol addition. Final package/version assessment must include it before publishing the currently unreleased daemon protocol.
