# Codebase Memory session transport

## Decision

Felan uses one lazy, root-session-scoped stdio MCP frontend for the reviewed
Codebase Memory 0.10.8 binary. The root agent and all descendant subagents share
one multiplexed newline-delimited JSON-RPC connection. Reference-counted
session leases keep it alive while any descendant is active and close it after
the last consumer shuts down. It does not delete the deterministic shared
runtime directory; Codebase Memory owns daemon and lease cleanup.

Agent Core exposes this through optional, adapter-neutral capabilities:
`startStdio()` provides literal argv with separate bounded stdout/stderr, and
`privateRuntime.ensureDirectory()` establishes a validated coordination path.
The extension retains a bounded one-shot CLI fallback only on runtimes without
the stdio capability. It never creates a POSIX coordination path with shell
`mkdir -p`.

## Alternatives

- **Per-call CLI:** rejected because each request pays the shipped binary's
  temporary-daemon and frontend startup cost.
- **Permanent daemon plus CLI:** rejected because it leaves global lifecycle
  ownership ambiguous and still starts a CLI frontend for every request.
- **Per-agent stdio frontend:** rejected because root and subagent MCP requests
  are already multiplexable, while each idle native process adds CPU overhead.
- **Root-session stdio frontend:** accepted because cold startup is amortized,
  warm requests are low latency, and ownership follows the top-level Felan
  session without coupling to the daemon's private protocol.

## Consequences

The runtime contract gains optional capabilities, preserving existing adapters
and shell-process consumers. The transport bounds frames, correlates IDs,
rejects malformed or unknown responses, cancels timed-out requests, rejects all
pending requests on frontend failure, and allows a later lazy restart. Cache-size
accounting runs after indexing so it cannot extend the transient `cbm: idx`
status.
