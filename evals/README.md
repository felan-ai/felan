# Felan extension evaluations

This is the home for Felan extension tests and benchmarks, powered by
`harness-evals`. Agent-comparison and smoke evaluations remain in the sibling
`harness-bench` repository.

Portable extension behavior belongs here when it can be exercised without
Felan Cloud: enabled/disabled effects, output quality, cost, tokens, latency,
and portable lifecycle contracts. The catalog contains cases across
Codebase Memory, MarkItDown, Memory, Output Style, Prewalk, RTK, Session
Compaction, Subagents, Tasks, and Web Access. Session compaction also has a
classifier-only method arm that requires
`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` and is not a savings claim until its
quality gate passes.

The `memory-processing-chunked-triage` case runs the actual local memory
worker on identical isolated sessions and prior wiki, with Jev triage enabled
or disabled. It requires an authenticated `openai-codex/gpt-6-luna` worker in
both arms and `TYPESAFE_API_KEY` only for the enabled arm. Run it serially after
`pnpm eval:build-source` and grade retained facts, later corrections and
citations before comparing **combined** classifier-plus-worker usage. See
[`results/2026-09-memory-processing-chunked/README.md`](results/2026-09-memory-processing-chunked/README.md):
three paired checks of the previous decision-map design passed after remediation,
but the classifier added measured tokens and its USD cost was unavailable.
The current inspect/noise split has its own three-pair quality and usage report
in [`results/2026-09-memory-processing-inspect-noise/README.md`](results/2026-09-memory-processing-inspect-noise/README.md).
All six final arms passed quality checks, but those runs predate the new
worker-readable inspect view. The [offline format comparison](results/2026-09-memory-inspect-text-view/README.md)
covers view/JSONL quality parity and byte size; provider-backed cost and latency for the view remain
unmeasured. No net savings are established:
classifier USD cost was unavailable and enabled latency increased. Do not
run provider-backed cases without explicit authorization.

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

The evaluator's manifest and lockfile pin the published `harness-evals@0.2.16`.
For local development, this checkout currently resolves `evals/node_modules/harness-evals`
through a symlink to the sibling `../harness-evals` source; check that package's
version before attributing a run to the locked release. The harness cleanup fix
is backward-compatible and therefore a patch release (`0.2.18`) of that
package; it is not published by this validation. Keep the evaluator lock on the
last available registry version until `0.2.18` is published, then update the
manifest and lock together before release-facing benchmark runs.

Each run's private copied auth/config files live under its harness-owned
`config/` directory and are removed after every outcome, regardless of
`--cleanup`. The persistent auth profile and environment credentials are not
deleted. `--cleanup` controls only registered adapter cleanup paths; retained
run workspaces and `.eval-output` diagnostics remain available for grading and
failure triage. Persisted driver/verifier diagnostics use allowlisted phases,
selection summaries, child statuses, safe error categories and bounded
assertion values. They must not include auth material, prompts, transcripts,
raw provider errors, or absolute paths.

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

## Native Pi code-mode diagnostic

The opt-in [code-mode benchmark](cases/codemode/README.md) compares direct tools,
optional Pi code mode, and code-mode-only exposure on five verified synthetic
tasks, including three Pit-inspired music workflows. Use the framework for
scheduling, repeated attempts, isolation, usage parsing and reporting, with the
recorded current-source image and explicitly authorized authentication. It does
not enable code mode in the shipped TUI. See the case guide for commands,
grading, limitations and the retained legacy diagnostic evidence.
