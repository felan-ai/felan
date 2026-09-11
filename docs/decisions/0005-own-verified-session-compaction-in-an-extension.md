# ADR 0005: Own verified session compaction in an extension

> Status: Accepted
> Date: 2026-09-11
> Deciders: Felan maintainers
> Related: [`Pi_Compaction_Research.md`](../research/Pi_Compaction_Research.md),
> [`pi-smart-compact` 9.6.2](https://github.com/alpertarhan/pi-smart-compact/tree/687f72c45d27f98ca36d7d1ca9b3941817b0e223),
> [`@sting8k/pi-vcc` 0.7.2](https://github.com/sting8k/pi-vcc/tree/b1b8b3ad748e2c77e8a1da26dc384e58a5bb771f)

## Context

Pi 0.85.1 owns Felan's session tree, compaction triggers, cut points, retained
tail, overflow retry, and append-only persistence. Its native summarizer is a
credible fallback, but it serializes only the first 2,000 characters of each
tool result and tracks file operations only for Pi's `read`, `write`, and
`edit` tools. That misses structured Felan evidence such as `apply_patch`
outcomes, background-process state, task records, and RTK recovery metadata.
Repeated free-form summary updates can also lose early constraints or preserve
unsupported completion claims.

Felan's local host loads only source-controlled built-ins. Importing either
reviewed extension directly would bypass that policy and take on unrelated
configuration, filesystem, UI, memory, or provider behavior. A Felan-owned
implementation can instead consume the public Pi lifecycle and the structured
results of Felan tools.

## Decision

Create `@felan-ai/ext-session-compaction` as a portable extension. The local
host enables it by default with the other built-ins and may disable it through
`builtinExtensions.sessionCompaction: false`. The summary model is configurable
through `extensionConfig.sessionCompaction.model`, defaulting to `inherit`; this
does not create a separate strategy or mode. When the package is present it attempts verified summarization;
when absent, Pi uses its native summarizer.

The extension handles `session_before_compact` and may return only a replacement
`CompactionResult`. Pi remains authoritative for preparation, the
`firstKeptEntryId`, recent-tail retention, manual and automatic triggers,
overflow continuation, tree semantics, persistence, and context rebuilding.
The extension must not append or rewrite compaction entries itself.

For each prepared eviction span, the extension:

1. deterministically extracts bounded, source-referenced evidence before any
   transcript truncation;
2. distinguishes user requests, observations, agent reports, and outcomes
   supported by recorded tool results;
3. asks the configured summary model once for a canonical continuation checkpoint;
4. rejects unsupported outcome claims and deterministically appends missing
   protected continuity within a fixed output budget; and
5. returns versioned, namespaced provenance and continuity data in
   `CompactionEntry.details`.

The synthesis boundary is Pi's `messagesToSummarize`, `turnPrefixMessages`, and
`previousSummary`. The complete active branch may be used only for bounded
source mapping and validated prior Felan details; retained or abandoned branch
content must not be resummarized accidentally. Protected facts retire only
when later evidence positively resolves them or the user explicitly overrides
them. Bounds may report omitted evidence but must never claim semantic
completeness.

A unique attempt marker in the returned details correlates transient work with
the persisted active-branch checkpoint. `session_compact` and
`session_compact_failed` are reconciliation signals, not transaction IDs.
Persisted Pi entries remain authoritative, and transient candidates are cleared
on failure, cancellation, supersession, tree or session replacement, and
shutdown.

Before returning a custom result, generation, validation, or budget failure
falls through to native Pi compaction. User cancellation remains cancellation.
After Pi accepts a custom result, a later persistence failure cannot
automatically rerun native summarization and must not be reported as though it
did. A native fallback may make another model request after the extension's
failed attempt.

The same package exposes `session_recall`, a bounded read-only tool over
`SessionManager.getBranch()`. It searches only the current active lineage,
returns stable session and entry source IDs, and supports bounded pagination
and entry expansion. It never reads session JSONL directly, falls back to all
entries, searches sibling branches, or reads RTK recovery files. Recalled
transcript and generated summaries are explicitly untrusted evidence.

The implementation is Felan-original code informed by the verification and
continuity concepts in `pi-smart-compact` and the active-lineage recall concept
in `pi-vcc`. It does not vendor either extension or add cross-session memory,
SQLite indexes, exploration/model-routing stages, dashboards, backups, or
custom settings UI.

## Alternatives Considered

- Keep native Pi compaction unchanged: rejected as the target because it does
  not preserve Felan's structured tool evidence or expose evicted active-lineage
  evidence for recall. It remains the disable path and safe fallback.
- Import or selectively vendor `pi-smart-compact`: rejected because its full
  storage, provider, UI, and cross-session surfaces conflict with Felan's
  ownership boundaries and would create a second compaction product.
- Use the `pi-vcc` deterministic compiler: rejected as the primary summarizer
  because its published benchmark does not compare against native Pi and a
  deterministic transcript brief is weaker for implicit rationale and negative
  constraints. Its npm artifact also lacks packaged license metadata, so no VCC
  source is copied.
- Add `native` and `verified` extension configuration modes: rejected because
  built-in enablement already supplies the control and rollback boundary.

## Consequences

- Felan gains a versioned session-continuity contract and branch-scoped recall
  without forking Pi or taking ownership of session persistence.
- Enabled compactions normally spend one additional configured-summary-model request;
  pre-acceptance fallback can spend a second native request. No savings claim is
  made without continuation-task evidence. Summary requests disable cache
  retention and do not invalidate the main agent request's cache directly.
- Structured details from other extensions remain `unknown` input and require
  conservative validation. A successful command is historical evidence, not
  proof that the current workspace is correct, and a partial patch must retain
  both its applied changes and failure.
- File continuity needed by a later native checkpoint must also appear in the
  summary text because Pi intentionally ignores file details from hook-created
  compactions.
- Recall can return the compacted RTK result and its recovery pointer, but not
  the original recovery artifact. Cross-session and sibling-branch retrieval
  remain out of scope.
- The package requires provider-compatibility, adversarial transcript,
  lifecycle, branch, repeated-compaction, and packed-release coverage before
  release. Disabling the package removes both its hook and recall tool without
  migrating or rewriting existing session history.
