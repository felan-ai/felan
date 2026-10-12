# Session Protocol

- Own only runtime-neutral, browser-compatible protocol v1 data and validation. No Node, Pi, Agent Core, TUI, ACP, filesystem, platform or renderer imports.
- Keep operation schemas, eligibility, request identity, results, events and resource limits consistent. New execution semantics require explicit capability negotiation or a protocol version change.
- Runtime parsers are the input boundary; TypeScript types and JSON Schema shape checks alone do not enforce UTF-8, aggregate limits or cross-field invariants.
- All sessions use the daemon launch environment. Do not add per-session environment provisioning, transport, handles or resume re-provisioning. Never serialize environment values in events, snapshots, stored rows, request identities or diagnostics.
- This package does not implement admission, authorization, persistence, reducers, lifecycle or interaction arbitration. Consumers must enforce those contracts.
- Initial public version is 0.1.0. Breaking public changes require the next minor under the repository's 0.x policy.
