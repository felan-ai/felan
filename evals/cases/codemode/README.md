# Native Pi code-mode evaluation

This experiment compares the current-source Felan runtime with its shipped
`codemode.mode` configuration. It does not restore `ext-run`.

## Configurations and cases

- `direct`: `codemode.mode: off`, direct tools.
- `on`: `codemode.mode: on`, the same tools plus optional native code mode.
- `only`: `codemode.mode: only`, the same underlying tools declared only through code mode.

Every arm uses the same model, thinking level, Felan base prompt, fresh state
and deterministic grading. Other extensions, skills, ambient instructions,
automatic compaction, provider retries and code mode's model helpers are
excluded. API cases expose only their synthetic APIs; the migration control
exposes `read`, `write`, `edit` and `bash` in every arm.

| Case | Verified outcome |
| --- | --- |
| `service-risk-audit` | Exact filtered join of 240 services, 24 teams and 960 incidents |
| `structured-migration` | Migrate three service configurations; preserve unrelated bytes and complete file inventory |
| `listening-summary` | Deduplicate actual plays, exclude selections/short plays, aggregate seconds and enrich album metadata |
| `playlist-recovery` | Preserve the playlist, look up exact-recording alternates, retry a transient failure and preserve order without duplicates |
| `feedback-cycle` | Deduplicate and join feedback/listening, apply the specified formula and persist the exact report |

The three music cases are inspired by Pit's
[historical case study](https://github.com/cv/pit/tree/main/docs/case_study).
All data and mutations are synthetic. No music account or publication is
involved. Saved executable functions and cross-session reuse are not tested.
These are targeted API workloads plus a small editing control, not a
representative coding-agent leaderboard.

## Framework workflow

Use `harness-evals` for scheduling, repetition, isolation, timeouts, usage
parsing and reports. The adapter selects the per-case fixture and configured mode; the fixture writes
that mode to isolated Felan settings, creates the shipped local runtime, injects
only synthetic APIs and emits standard Pi JSONL events. It verifies startup
activation and never registers or activates the code-mode tool itself. The framework's existing Felan parser handles those events.
Verifiers consume deterministic grades beside each case.

```sh
pnpm eval:build-source
pnpm eval:test
pnpm --dir evals run list --config codemode-evals.yaml
```

For a smoke (one existing case, all three modes, one attempt), after provider
authorization and fresh credential setup:

```sh
pnpm --dir evals run run --config codemode-evals.yaml \
  --case codemode-listening-summary \
  --agents felan-codemode-direct,felan-codemode-on,felan-codemode-only \
  --attempts 1 --concurrency 1 --cleanup
```

For the full evaluation, only after separate authorization:

```sh
pnpm --dir evals run run --config codemode-evals.yaml \
  --agents felan-codemode-direct,felan-codemode-on,felan-codemode-only \
  --attempts 3 --concurrency 1 --cleanup
pnpm --dir evals exec harness-evals view --config codemode-evals.yaml \
  --latest --no-open
```

This selects five cases × three configurations × three independent attempts.
Use the recorded current-source image, never a published-package fallback.
Credentials and runtime artifacts remain framework-owned. Do not reuse the
credentials previously exposed from `evals/.env`.

Report correctness before cost, tokens and latency. USD figures from Pi are
model-catalog estimates, not subscription billing. Retain cache-token counts;
three attempts are exploratory, not statistical proof. Framework step timing
includes Felan runtime initialization as well as execution; it differs from the narrower
agent-loop timing of the initial diagnostic.

## Initial diagnostic evidence

The completed 45-session Docker diagnostic is retained locally under
`.harness-evals/codemode/2026-09-30-pi-0.99.1-docker/`. Its raw results, exact
input snapshots and source-image provenance remain evidence, but are **not**
framework-native run/report artifacts. The bespoke running/reporting scripts
and their package commands were removed. The interrupted local pilot is
excluded. Do not write a converter or claim a framework report exists; ask
before rerunning if a framework-native report is required.

The initial diagnostic used direct SDK factory injection, not the shipped Felan
configuration. The migrated runtime profiles use new comparison IDs so that
evidence is not silently treated as measurements of the new integration.
