# Felan extension evaluations

This is the home for Felan extension tests and benchmarks, powered by
`harness-evals`. Agent-comparison and smoke evaluations remain in the sibling
`harness-bench` repository.

Portable extension behavior belongs here when it can be exercised without
Felan Cloud: enabled/disabled effects, output quality, cost, tokens, latency,
and portable lifecycle contracts. The catalog contains 24 cases across
Codebase Memory, MarkItDown, Memory, Output Style, Prewalk, RTK, Session
Compaction, Subagents, Tasks, and Web Access.

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
