# ADR 0045: Compact before prompt-cache expiry

> Status: Accepted
> Date: 2026-10-23
> Deciders: Felan maintainers
> Related: [ADR 0017](0017-session-compaction-methods.md),
> [ADR 0005](0005-own-verified-session-compaction-in-an-extension.md),
> [session-compaction README](../../packages/ext-session-compaction/README.md)

## Context

A large idle session can outlive its provider's prompt cache, leaving the next
request to send the full context without cache reuse. A known cache lifetime
provides a scheduling boundary for compaction before expiry. Pi must retain
ownership of preparation, kept tails, and persistence; a failed idle attempt
must not trigger native summarization without a new user request.

## Decision

Enable `compactBeforeCacheExpiry` by default with `minContextTokens: 200000`.
Schedule at turn end and on session start, tree navigation, or model change,
roughly 20 seconds before a known expiry. Recheck that Pi
auto-compaction is enabled, the agent is idle, nothing is queued, and context
usage meets the minimum. Cache-warm events extend the deadline; unknown
lifetimes never schedule an attempt. Disabling this setting leaves ordinary
compaction unchanged.

Use the configured method: opt-in `classifier` when configured and available,
otherwise Felan's fresh verified `summary`, which is the default. A failed
classifier request may fall back to the verified summary. Eligibility requires
an available classifier for that method or a resolvable summary model. Every
failure before acceptance that cannot be recovered by the verified summary
cancels the expiry attempt. Never fall back to native Pi, append a
native-fallback diagnostic, or show a native-fallback notification for expiry
compaction. Ordinary compaction retains its summary-to-native fallback.

Preserve claim checks and protected continuity. Append bounded Pi-format
read/modified file lists merged with prior compaction details. Expiry results
record `trigger: 'cache-expiry'`. Info-level summary-request logs record model,
trigger, outcome, and latency, plus usage, cost, and cache share when available.
Use public runtime/Pi APIs, a portable notification, and structured logs.

The cache-state and expiry scheduler adapt pi-cached-compaction 0.1.0 (MIT),
with attribution in package/root notices limited to `src/internal/cache-state.ts`
and `src/expiry.ts`.

## Alternatives Considered

- Cached-prefix summarization: rejected after the
  [cached-summary benchmark](../benchmarks/cached-summary-compaction.md).
  It cost ~1.8x more per compaction than the fresh verified summary, with no
  demonstrated quality difference in n=3 per arm. Remove the cached-summary
  path rather than retain an unhelpful fallback.
- Compact only on demand: simpler and avoids unsolicited work, but leaves large
  idle contexts unchanged when a known cache lifetime expires. Retain an
  independent opt-out and conservative scheduling gates.
- Fall back to native Pi on expiry failure: rejected because an idle attempt
  must not escalate beyond the configured classifier and verified summary.
- Change process-environment cache retention or read settings files directly:
  rejected because retention belongs to the host/provider, and effective settings
  are available through Pi's public API.
- Write trace files or add a TUI countdown card: rejected because structured
  runtime logs and a portable notification suffice without storage/UI ownership.

## Consequences

- Expiry compaction's cost benefit has not been benchmarked. Neither a smaller
  next request nor token reduction alone establishes net savings; verification
  must include continuation quality, all compaction/request costs, and latency.
- Idle compaction may surprise users and spend tokens without a new prompt.
  A notification, auto-compaction gate, context minimum, known-lifetime rule,
  and separate opt-out limit that behavior. Failed expiry attempts cancel
  without native fallback.
- Provider cache lifetimes and warm events constrain scheduling; the extension
  does not change retention policy or promise a cache hit. Verified summaries
  protect continuity but do not prove semantic completeness.
