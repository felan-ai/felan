# Felan extension evaluations

This directory owns Felan extension benchmarks and their deterministic grading
assets. It is intentionally outside the pnpm workspace packages.

- Cases live under `cases/**/*.eval.yaml`.
- Verifiers live beside their case under `cases/<family>/<case>/verifier/`.
- Fixtures are versioned under `fixtures/<name>/<version>/source/`.
- Generated runs under `.harness-evals/` and `source-image.json` are ignored.
- Historical published evidence under `results/` is immutable; do not rewrite
  its files or checksums.

The suite runs against the current Felan source only. From this directory,
build the source image with `pnpm build:source`, then use `pnpm run list` or
`pnpm run run`. These commands require the recorded source image and never
silently fall back to a published Felan package.

Do not run provider-backed cases without explicit authorization. Offline checks
are `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm run list`.
