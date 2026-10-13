# ADR 0020: Own the local session protocol and stores in one daemon

> Status: Accepted for Story 1; implementation and platform gates remain open
> Date: 2026-10-10
> Deciders: Felan maintainers, approved Story 1 plan
> Related: [Implementation handoff](../maintainers/session-daemon-implementation.md), [ADR 0004](0004-own-native-acp-in-the-local-host.md)

## Context

InteractiveMode, ACP and headless currently construct local runtimes and open
Pi session files. Keeping any of them as a second writer defeats detachable,
multi-client sessions. Agent Core is the portable engine, not a host service.
Local use must remain possible without a Felan account or network.

## Decision

Keep registry, ordered admission, interactions and control persistence in
`apps/tui`. Publish only browser-compatible message/schema contracts in
`@felan-ai/session-protocol`. Build an independent TUI client; adapt ACP and
headless to the same local endpoint in the same shipping cutover.

One production daemon per OS account holds kernel-lifetime ownership of its actual canonical
session, task, memory and child/process roots, including custom session paths.
Keep Pi transcripts as content authority and add bounded control metadata, not
a competing transcript backend. The final review removed legacy adoption:
pre-daemon data is not listed or resumable; explicit import creates a new ID.
This supersedes **only ADR 0004's in-process runtime/store ownership**; native
ACP in `apps/tui`, stdio discipline, authentication and capability limits remain.
Explicit isolated test/CI namespaces are permitted only with disposable roots
and pinned namespace/instance/root checks. Canonical store locks span all
namespaces; this does not permit multiple production owners or a test stop
falling back to the user's daemon.

## Alternatives considered

- Keep ACP/headless in-process: simpler cutover, but permits competing writers
  and retains client-owned execution lifetime.
- Use ACP/Pi RPC/pi-server as the core protocol: does not give Felan the required
  multi-client ownership, admission, recovery and interaction contract.
- Move daemon into Agent Core or a separate public daemon package: broadens the
  portable API with local policy and splits the intended composition root.

## Consequences

- Clients cannot fall back to opening stores when a daemon is unavailable.
- Native ownership/peer checks need platform evidence and packaging; unsupported
  platforms block release rather than silently use unsafe leases.
- Old noncooperating binaries are a disclosed best-effort detection risk.
- No connector, database or cloud execution is introduced by this decision.
