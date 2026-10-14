# ADR 0029: Activate daemon services after session registration

Status: Accepted

## Context

Daemon-owned subagent and presentation services need a real registry binding.
Constructing them as already active during profile opening makes their startup
callbacks refer to a session that is not registered yet. Publishing a partial
registry entry instead would expose incomplete lifecycle and ownership state.

## Decision

Allow a profile binding to expose an optional activation phase. The local daemon
profile can prepare runtime and extension definitions, then the registry installs
the complete binding before activating session hooks and services. Activation is
idempotent; a failed activation is cleaned up while its registry identity remains
available to its owned services. Existing non-deferred profile consumers keep
their current opening behavior.

Subagent preparation may discover definitions and reconcile its own stored
records, but it cannot dispatch or publish into the registry until activation.
This keeps one real host per root rather than introducing an AgentSession facade.

## Alternatives considered

- Publishing a partial registry binding would weaken admission and cleanup
  invariants during asynchronous opening.
- Constructing a second host after startup would duplicate root ownership and
  could attach extensions to stale service instances.
- Rebinding all extensions after opening would rerun startup hooks and could
  duplicate effects and listeners.

## Consequences

The registry owns activation and failure cleanup. Custom profiles without the
optional phase remain compatible. Production composition must opt into deferred
activation and must not execute work during its configuration preflight.
