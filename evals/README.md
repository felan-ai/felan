# Felan extension evaluations

This is the home for Felan extension tests and benchmarks, powered by
`harness-evals`. Agent-comparison and smoke evaluations remain in the sibling
`harness-bench` repository.

## Layout

- `cases/` — extension-specific prompts, assertions, and verifiers.
- `fixtures/` — immutable authored starting workspaces.
- `adapters/` — project adapters used by the cases.
- `runtimes/` — reusable Docker runtime assets.
- `results/` — published historical extension evidence.

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

The `run-code` benchmark compares the current source with bounded code mode
disabled versus enabled on the read-heavy Codebase Memory tasks. It is an
extension benchmark and therefore belongs here, not in `harness-bench`.
