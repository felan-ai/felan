# ADR 0011: Trust commands after existing-browser authorization

> Status: Accepted
> Date: 2026-09-14
> Deciders: Felan maintainers
> Related: [ADR 0006](0006-authorize-existing-browser-control.md), [ADR 0008](0008-browser-authorization-policy.md)

## Context

Felan's raw-CDP attachment used a command allowlist and four native identity
probes before and after every browser command. The result was incompatible with
the reviewed `agent-browser` skill, rejected ordinary diagnostics and
authenticated-browser commands, and converted useful native failures into
opaque authorization errors. Codex's existing-Chrome integration instead
keeps a browser binding and recovers stale tabs through the browser relay.

## Decision

Once the user authorizes an existing Chrome session, Felan treats the attached
browser as a trusted native `agent-browser` session. The extension no longer
maintains an attached-only command allowlist or performs daemon, endpoint,
target, and URL probes around each command. It performs the identity
observation during authorization, uses one deterministic Felan session and the
leased endpoint for subsequent commands, and lets native command errors return
through the normal tool failure path.

Felan continues to own session and namespace routing, configuration and output
bounds, screenshot staging, connection leasing, explicit revocation, shutdown,
cleanup confirmation, and host-only setup/control-plane operations. User
attempts to replace the leased endpoint or Felan routing are removed before
dispatch. Authorization is still session-scoped and Chrome's browser-wide CDP
authority is disclosed in the consent flow.

## Alternatives Considered

- Keep continuous probes and the attached allowlist: rejected because they
  broke the native CLI workflow and caused repeated false authorization
  failures.
- Pass all arguments and connection options through unchanged: rejected
  because the model could replace Felan's session, endpoint, output bounds, or
  configuration.
- Build a Chrome extension/native-messaging relay: deferred as the stronger
  long-term tab-scoped architecture, but materially larger than this repair.

## Consequences

- Authorized browser commands match the native CLI and can use sensitive
  authenticated browser state, diagnostics, cookies, network inspection, and
  page JavaScript.
- A target or daemon change is reported by the native session rather than
  proactively detected by Felan; the user may reauthorize or recover through
  native tab commands when necessary.
- Lease disconnects, explicit revoke, shutdown, failed authorization, and
  unconfirmed cleanup still remove or quarantine Felan's transport authority.
- Existing ADR 0008 remains the historical rationale for cross-origin consent;
  its continuous attached-command enforcement is superseded by this decision.
