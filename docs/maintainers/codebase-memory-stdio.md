# Codebase Memory session transport

## Decision

Felan uses one lazy, session-scoped stdio MCP frontend for the reviewed
Codebase Memory 0.10.8 binary. The frontend starts on the first index or query,
reuses one newline-delimited JSON-RPC connection, and is awaited and disposed
at `session_shutdown`. It does not delete the deterministic shared runtime
directory; Codebase Memory owns daemon and lease cleanup.

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
- **Session stdio frontend:** accepted because cold startup is amortized,
  warm requests are low latency, and ownership follows the Felan session.

## Consequences

The runtime contract gains optional capabilities, preserving existing adapters
and shell-process consumers. The transport bounds frames, correlates IDs,
rejects malformed or unknown responses, cancels timed-out requests, rejects all
pending requests on frontend failure, and allows a later lazy restart. Cache-size
accounting runs after indexing so it cannot extend the transient `cbm: idx`
status.
