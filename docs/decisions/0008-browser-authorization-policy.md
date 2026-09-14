# ADR 0008: Make existing-browser authorization cross-origin with a persistent consent policy

> Status: Accepted
> Date: 2026-09-14
> Deciders: Felan maintainers
> Related: [ADR 0006](0006-authorize-existing-browser-control.md), [ADR 0011](0011-trust-authorized-existing-browser-commands.md), [Browser extension](../../packages/ext-browser/README.md)

## Context

Existing Chrome attachment uses browser-level CDP authority. ADR 0006 added a
fresh pinned tab and exact-origin checks as defense in depth, but authenticated
workflows commonly need to move between multiple HTTP(S) origins. The local
user also needs a way to approve this high-trust flow once without repeating
the Felan prompt, while retaining the ability to restore the default prompt.

## Decision

The requested URL remains the initial destination for a fresh attached tab, but
it is not an authorization boundary. An authorized pinned tab may navigate
between HTTP(S) origins. Felan continues to pin the initial target and revoke
leased authority on loss, cancellation, cleanup failure, or shutdown. The
later [ADR 0011](0011-trust-authorized-existing-browser-commands.md) supersedes
the per-command attached allowlist and continuous identity probes. Chrome's own
remote-debugging approval remains independent.

The local TUI offers `ask` (the default) and `always-allow`. The first prompt
offers Allow once, Always allow, and Deny. Always allow is persisted as a
global browser extension preference; changing it back to ask affects later
authorizations. Live grants, leases, endpoints, targets, cookies, and browser
state remain in memory only. Revoke remains the control for an active grant.

## Alternatives Considered

- Keep exact-origin authorization: rejected because it blocks legitimate
  authenticated multi-origin workflows.
- Persist an origin allowlist: rejected because the requested behavior is not
  origin restriction and an allowlist would retain the same workflow friction.
- Persist a blanket grant or CDP endpoint: rejected because it would outlive
  the session and bypass Chrome/process/lease checks.

## Consequences

- Existing-browser workflows can follow HTTP(S) redirects and related sites
  without reauthorization.
- The persisted preference reduces repeated Felan prompts but increases trust;
  the default remains ask and Chrome still presents its own approval.
- CDP is still browser-wide authority. Pinned targets and leases remain
  connection controls, not network isolation; authorized commands can access
  authenticated browser data and advanced native capabilities.
