# Felan extension evaluations

This is the home for Felan extension tests and benchmarks, powered by
`harness-evals`. Agent-comparison and smoke evaluations remain in the sibling
`harness-bench` repository.

Portable extension behavior belongs here when it can be exercised without
Felan Cloud: enabled/disabled effects, output quality, cost, tokens, latency,
and portable lifecycle contracts. The catalog contains 25 cases across
Codebase Memory, MarkItDown, Memory, Output Style, Prewalk, RTK, Session
Compaction, Subagents, Tasks, and Web Access. Session compaction also has a
classifier-only method arm that requires
`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` and is not a savings claim until its
quality gate passes.

The `subagents-routing` benchmark compares subagent routing with and without
the discovery classifier in one-shot JSON mode. Its cases check that small or
known-surface investigation stays in the parent and that two independent
unknown flows are answered correctly. One-shot mode exits when the parent
settles, so it cannot wait for asynchronous child completions. The explicit
implementation/review case remains as a diagnostic under the `subagents` suite,
but is not part of this quality benchmark until headless sessions can await
completion notices. The historical
six-run Grok pilot predates this policy and does not validate it. The benchmark
reuses the local Felan xAI subscription OAuth profile; the classified arm
additionally requires `TYPESAFE_API_KEY`. Discovery classification is skipped
in one-shot runs to avoid returning a pending-child status as a final answer.
Run it serially with cleanup:

```sh
pnpm eval:build-source
TYPESAFE_API_KEY=... pnpm eval:run --benchmark subagents-routing --concurrency 1 --cleanup
```

Each Grok arm opts into a `subagent-routing.jsonl` run artifact copied from the
structured host log before cleanup. The corresponding `events-summary.json`
also includes those records under `subagentRouting`, so a routing failure can be
attributed to classifier selection, fallback, or model non-adherence without
retaining OAuth files. The trace includes the decision probability, classifier
metadata, and generated section name; enable capture only for controlled eval
catalogs without secrets.

The September 24 runs, including the initial headless-mode failure and the
quality-passing rerun, are documented in
[`results/2026-09-routing-guidance/README.md`](results/2026-09-routing-guidance/README.md).
Neither run measured savings from actual delegation.

The `prewalk-classifier` benchmark runs the verified `prewalk-checkout` case
against two identical Prewalk configurations with a `low` tier target and
subagents disabled (one-shot JSON runs cannot await asynchronous review).
Only the candidate receives `TYPESAFE_API_KEY`, enabling entry,
exploration-depth, implementation-profile, and completion decisions. In this
one-shot lane `Agent` is disabled: a completion verdict requiring review cannot
finish the run, so an end-to-end review comparison still needs a
persistent-session benchmark.
Both arms use the same model, thinking level, fixture commit, and verifier.
Use three serial trials and require quality before comparing cost. The harness
objectives cover quality and cost; also report prompt/output tokens and step
duration from the run results. Token reduction alone is not a savings claim.
After explicit authorization and credential setup, build the current source
image and run:

```sh
pnpm eval:build-source
TYPESAFE_API_KEY=... pnpm eval:run --benchmark prewalk-classifier --concurrency 1 --cleanup
```

Do not run these provider-backed benchmarks without explicit authorization.

The `output-style-concise` benchmark also uses the unreleased structured
`jevJudge` integration during local validation. It requires a host-side
`TYPESAFE_API_KEY`; the key is not forwarded to evaluated agents or persisted
in reports. Jev scores are additive evidence; deterministic assertions remain
the benchmark's pass/fail gates. Run it serially with cleanup after linking the
local `../harness-evals` checkout:

```sh
TYPESAFE_API_KEY=... pnpm eval:run --benchmark output-style-concise --concurrency 1 --cleanup
```

Felan Cloud's `apps/agent/evals` owns platform composition and product
workflows: cloud session persistence, runtime wiring, system events, runtime
catalogs and skills, workspace/container ownership, entitlements, Slack/API
routing, Git/PR workflows, QA behavior, and archive publication.

## Layout

- `cases/` — extension-specific prompts, assertions, and verifiers.
- `fixtures/` — immutable authored starting workspaces.
- `adapters/` — project adapters used by the cases.
- `runtimes/` — reusable Docker runtime assets.
- `results/` — published historical extension evidence.

Do not duplicate a case merely because both repositories mention an extension.
Overlap is appropriate only when the Felan case checks portable behavior and
the platform case checks host composition.

## Current-source workflow

The only runnable Felan lane uses the current checkout. It builds every package,
packs the exact workspace artifacts, installs those artifacts into a narrow
Docker context, and records the source commit, dirty state, package hashes, and
image ID in ignored `source-image.json`.

```sh
pnpm --dir evals install --frozen-lockfile
pnpm eval:test
pnpm eval:build-runtime
pnpm eval:build-source
pnpm eval:list
pnpm eval:run --case <case-id> --concurrency 1
pnpm eval:view
```

Source-image builds are local development actions and do not make model calls.
Benchmark runs may use paid or subscription providers and require explicit
authorization. Keep run artifacts, credentials, and caches out of Git.
