# ADR 0007: Compose active tools through local code mode

> Status: Superseded by [ADR 0010](0010-retire-code-mode.md)
> Date: 2026-09-13
> Deciders: Felan maintainers
> Related: [Vercel Run](https://vercel.com/blog/introducing-run)

## Context

Agents often need to call several independent tools, transform their results,
and return only a small answer. Individual model tool calls add orchestration
turns and expose intermediate output. Vercel's Run SDK provides a local
QuickJS worker with explicit host functions, serialization, and resource
limits, but it does not replace the host's authorization or side-effect policy.

Felan's Pi integration exposes tool definitions and lifecycle hooks but no
public nested dispatcher. Calling raw definitions from an extension would
bypass argument validation, active-tool selection, authorization hooks, and
result interception.

## Decision

Agent Core owns a session-scoped nested-tool invocation contract. It resolves
the current active tool registry and preserves the normal preparation,
validation, before/after hook, cancellation, result, and sequential-execution
semantics without appending synthetic transcript entries. `@felan-ai/ext-run`
owns the QuickJS boundary, guest API, catalog, limits, text-only conversion,
and code-mode policy. The local TUI enables it as a source-controlled built-in
without dependency onboarding.

The default catalog is read-only/bounded. Other exact active tools may be
configured deliberately, but code mode always excludes itself and planning or
lifecycle controls. Direct tools remain the path for interactive, mutating,
image-producing, and control-plane operations. There is no continuation,
rollback, or OS-level isolation promise.

Nested termination is host policy, not a catchable guest decision: the extension
aborts the worker and propagates bounded, text-only termination content and
error status to the outer result. Nested calls, including opted-in side effects,
retain a bounded, terminal-safe audit of arguments and outcomes in host-only result details.
Sensitive argument keys are redacted case-insensitively. Pending patches keyed
by outer tool-call ID preserve audits when execution throws and are consumed by
the result hook; successful details are not replaced unnecessarily. Audit data
never enters model-visible content, and truncation or unknown outcomes are
explicit rather than implying a complete transaction history.

## Alternatives Considered

- Keep one model call per tool: rejected because it cannot efficiently express
  parallel composition and result filtering.
- Call raw `ToolDefinition.execute` from the extension: rejected because it
  bypasses Pi's validation and policy/lifecycle pipeline.
- Fork or patch Pi's agent loop: rejected because it creates a long-lived
  maintenance fork; the narrow Agent Core contract is sufficient.
- Expose every active tool by default: rejected because shell, browser, auth,
  tasks, subagents, and lifecycle tools carry broad or non-composable effects.
- Guest-only error handling and transient call logs: rejected because guest
  catches could suppress host termination and failures could erase evidence of
  partial side effects.

## Consequences

- Independent read and research calls can run concurrently inside one bounded
  local invocation, reducing intermediate model-visible output.
- Nested calls remain host-authorized and untrusted results remain bounded;
  nested side effects are not atomic. Bounded, key-redacted audit summaries are
  not exhaustive records or secret detection for arbitrary text.
- The dispatcher must track Pi API changes and extensions must preserve exact
  allowlists, output bounds, cancellation, and reload-safe session ownership.
- No savings claim is made until representative verified-task benchmarks exist.
