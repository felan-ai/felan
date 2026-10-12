# ADR 0022: Use the daemon launch environment and explicit daemon lifetime

> Status: Accepted for Story 1
> Date: 2026-10-10
> Deciders: Felan maintainers, explicit user environment and headless choices
> Related: [Environment contract](../maintainers/session-daemon-contracts.md#store-and-environment-ownership)

## Context

The original decision captured each creating client's environment and retained it
independently of detach/eviction. Investigation exposed ambient provider/SDK,
proxy and credential-command behavior that a small wrapper cannot isolate.

## Superseding decision

The user explicitly changed the requirement: "lets for now use the same env as
the deamon, not pre session". All sessions and descendants now use the daemon's
launch environment, fixed for that process lifetime. Restart under the desired
environment to change PATH, proxy or provider variables. This intentionally
accepts first-daemon-launch-wins behavior; it is no longer a rejected alternative.
There is no environment provisioning/refresh protocol, per-session retention
owner, mandatory getEnv accessor, or missing-environment recovery gate.

Initialize PI_* host settings and the HTTP proxy dispatcher once at startup;
changing runtime `httpProxy` or `httpIdleTimeoutMs` settings requires restart. Do not mutate process.env
or process cwd for individual sessions. Session tools retain explicit runtime
cwd. Pi command credentials use the daemon cwd where no cwd input is exposed.
Preserve existing provider/auth/virtual-routing behavior and locked standard
credential refresh. Keep per-session config/model registrations independent.
Never journal/log environment or credential values, and never place endpoint or
control-token secrets in the process environment inherited by tools.

The daemon is persistent, including for headless and CI use. Clients detach on
exit. Stop/restart is explicit and uses drain/ownership recovery, never an
attachment-count heuristic.

## Alternatives considered

- **Selected by the superseding user choice:** first daemon launch wins. A later
  client does not implicitly replace the environment. Restart is the explicit
  way to change it.
- Creating-client environment capture and retention: the original choice, now
  superseded rather than kept as speculative machinery.
- Temporarily mutate global environment/cwd per turn: still rejected because
  sessions and asynchronous providers execute concurrently.
- Persist raw environment: still rejected because it exposes secrets and is not
  needed for process-owned state.

## Consequences

- CI must explicitly stop its disposable daemon and use isolated roots.
- CI selects an isolated target explicitly and pins namespace, roots and
  instance; no ambient selector or production-default cleanup is allowed.
- Restart uses its new launch environment and standard credential stores; no
  client reprovisioning step is required.
- No Pi patch/fork, isolated worker architecture or new provider dependency is
  needed for environment isolation. Provider compatibility is preserved.
- Shared launch environment is not a sandbox. Trusted in-process extensions can
  access process state and sibling data; loading them remains a trust decision.
