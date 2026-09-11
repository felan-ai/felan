# ADR 0004: Own native ACP in the local host

> Status: Accepted
> Date: 2026-09-10
> Deciders: Felan maintainers
> Related: [BUG-392](https://linear.app/bugzyai/issue/BUG-392/add-native-agent-client-protocol-acp-support-to-felan), [ACP v1 transport](https://agentclientprotocol.com/protocol/v1/transports)

## Context

Felan needs a native Agent Client Protocol endpoint for editor and IDE clients.
ACP requires newline-delimited JSON-RPC over stdio, strict protocol-only stdout,
independent session lifecycle, cancellation, and client-mediated interactions.
The existing `--mode` option means a one-shot `text` or `json` output format and
requires an initial prompt. Pi's RPC mode is adjacent machinery but is not ACP
and cannot represent ACP capabilities or client interactions directly.

The integration owns local credentials, persisted sessions, host runtime
construction, and extension presentation. Those responsibilities already
belong to `apps/tui`; Agent Core must remain adapter-neutral and feature-neutral.

## Decision

Expose stable ACP v1 through the `felan acp` subcommand, with no
`felan --mode acp` alias. Implement the protocol adapter in `apps/tui` using the
official TypeScript SDK and stdio transport. The adapter creates one in-process
`LocalFelanRuntime` per ACP session and shares only process-level services that
are safe to share, such as the local model registry.

Reserve stdout exclusively for ACP frames and route diagnostics to stderr. Use
existing Felan session files for restoration. Accept and ignore MCP definitions
provided on ACP session requests; keep the existing configured OAuth-only HTTP
MCP extension unchanged.

## Alternatives Considered

- Add `acp` to `--mode`: rejected because it would conflate a long-lived,
multi-session protocol server with one-shot output formatting and conflict with
the existing prompt requirement.
- Publish a separate `felan-acp` adapter: rejected because it would duplicate
local runtime, credentials, resource policy, and lifecycle ownership.
- Translate ACP to Pi RPC in a child process: rejected because it adds another
process/protocol boundary, weakens direct lifecycle control, and obscures
Felan-specific extensions and cleanup.

## Consequences

- ACP clients launch Felan with command `felan` and argument `acp`.
- The public application gains a long-lived protocol mode and an official ACP
SDK dependency, while portable packages remain ACP-neutral.
- Every advertised capability must correspond to implemented behavior; optional
or draft ACP features remain unadvertised.
- Protocol output, cancellation, interaction correlation, and credential
handling become security-critical local-host responsibilities.
- Client-provided MCP definitions do not alter Felan's configured MCP policy or
launch additional processes.
