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

The `subagents-routing` benchmark includes a six-run Grok 4.6 pilot comparing
static guidance with classifier-derived routing. It reuses the local Felan xAI
subscription OAuth profile; the classified arm additionally requires
`TYPESAFE_API_KEY`. The classified arm scores each catalog entry once and adds
one request-specific routing decision to the current turn's system prompt. Run
it serially with cleanup. The recorded pilot predates this authoritative
system-prompt decision and does not validate the current guidance:

```sh
TYPESAFE_API_KEY=... pnpm eval:run --benchmark subagents-routing --concurrency 1 --cleanup
```

Each Grok arm opts into a `subagent-routing.jsonl` run artifact copied from the
structured host log before cleanup. The corresponding `events-summary.json`
also includes those records under `subagentRouting`, so a routing failure can be
attributed to classifier selection, fallback, or model non-adherence without
retaining OAuth files. The trace includes exact generated guidance and catalog
descriptions; enable capture only for controlled eval catalogs without secrets.

Do not run this provider-backed benchmark without explicit authorization.

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
