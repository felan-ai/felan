# Daemon interaction broker

`InteractionBroker` owns pending questions, tool approvals and host setup
prompts. Session interactions are committed before publication. The first valid
answer records the winner through durable admission; detaching does not answer
or cancel an ordinary session question.

## Composition

`createRegistryInteractionBroker(registry)` binds the broker to canonical
storage. The server supplies authenticated transport facts, negotiated
interaction kinds and actual session attachments. Configured extensions use
`pi.ui.request`; the daemon translates generic forms into broker requests.
Tool approvals use the provider's tool policy. No extension-specific presenter
registration or custom interaction kind is required or supported.

## Lifetime and recovery

- Questions without a timeout may survive detach and reconnect.
- Drain defers eligible questions with a bounded expiry and cancels other waits.
- A deferred answer records a continuation before execution. Ready work can
  resume after recovery; dispatched work is not replayed and remains
  indeterminate if its outcome cannot be recovered.
- Busy preflight leaves a continuation ready. Continuations are serialized per
  session. Abort, timeout, drain and restart remain distinct outcomes.
- Settle broker, registry and writers before closing storage or releasing
  ownership.

## Eligibility and validation

Answers require the appropriate negotiated interaction kind and a current
session attachment, or an eligible host recipient. Verified transport supplies
local-console authority; the client-kind label does not. Owner-only requests
also require the owner principal. An ordinary form never grants authority to install a dependency or
perform another host operation.

Host prompts and transient OAuth presentation use out-of-band notifications.
OAuth URLs and transient credentials never enter the control snapshot. Losing
the last eligible OAuth client cancels that operation. Clients clear transient
state on transport loss; pending durable host prompts can be shown after the
next verified handshake.

Generic form answers are validated against the declared fields and action
before commit. Views and documents use `ui.action` with element ID, revision,
action ID and any declared item/input. Validation precedes effects. Optional
presentation hints cannot change authority, data, inputs or outcomes; unknown
hints use generic rendering.

Run daemon/client tests only through `scripts/test-isolated.sh`. The full
integration gate is `scripts/test-isolated.sh pnpm verify`.
