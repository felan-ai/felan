# ADR 0016: Jev classifier in Agent Core

> Status: Accepted
> Date: 2026-09-19
> Deciders: Felan maintainers
> Related: [ADR 0005](0005-own-verified-session-compaction-in-an-extension.md),
> [ADR 0014](0014-own-jev-classifier-service.md)

## Context

ADR 0014 placed Jev in `@felan-ai/ext-jev` so credentials could live in a
host-owned extension configuration without Agent Core taking a vendor, and so
owning extensions would not import Jev. That split made Jev look like an
extension when it is a shared System One client, and it made compaction config
vendor-aware.

Jev remains a classifier, not a summarizer. Compaction, Prewalk, and later
owners still must not compete as `session_before_compact` producers.

## Decision

Move the Jev client, transports, and structural classifier contract into Agent
Core. Agent Core exposes an optional, provider-neutral `Classifier` capability
through `AgentRuntime`; hosts may inject an implementation, while extensions
decide whether to use it. Consumers depend on the generic capability rather
than Jev-specific client or transport types. `@felan-ai/ext-jev` is retired.

The local TUI constructs the Jev implementation from `TYPESAFE_API_KEY` or
`OPENROUTER_API_KEY` and injects it into default runtimes. There is no global
`extensionConfig.jev` schema. Credentials stay host-owned and are not stored
in session files.

## Alternatives Considered

- Keep Jev as a config-only extension: rejected because it is not extension
  behavior and forces compaction to name Jev.
- Classifier contract in Agent Core with Jev remaining a separate package:
  rejected in favor of one core client now that multiple owners are expected.
- Compaction importing Jev directly: rejected because portable extensions still
  peer-depend only on Agent Core and must not own credentials.

## Consequences

- The optional runtime classifier is available to any extension, while each
  consumer owns its policy and behavior when the capability is absent.
- TypeSafe and OpenRouter hosts become an Agent Core I/O exception, still
  pinned and fetch-injected for tests.
- ADR 0014 is superseded for placement; its rules that Jev is not a compaction
  owner and that credentials stay host-owned still apply.
