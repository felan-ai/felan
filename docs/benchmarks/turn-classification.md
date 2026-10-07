# Shared turn classification benchmark

Status: provider-backed comparisons ran on 2026-10-07. Quality gates failed in
31 of 96 trials; see the [failure analysis](turn-classification-failures.md).
There is no measured savings conclusion because correctness gates failed and
subscription USD cost is unknown.

## Questions

1. Does the shared pass preserve correct entry, discovery and effort decisions?
2. Does approved Prewalk planning use a capable model at high effort before
   planning inference, while implementation honors the configured target?
3. Does aggregation reduce actual classifier requests and combined task cost,
   without reducing correctness or increasing user interventions?
4. What happens to input-to-first-output latency? The previous decisions already
   overlapped, so removing requests does not establish a proportional speedup.

## Arms

| Arm | Classifier behavior |
| --- | --- |
| Shared candidate | Registered entry questions share one snapshot and logical request; existing transport admission may batch oversized payloads. |
| Separate-producer baseline | An evaluation-only wrapper sends the same producer question groups separately, in parallel, over the same state. Phase policies and later workflow decisions remain identical. |
| Disabled baseline | No classifier capability is injected. Persistent guidance, static capable planning and the configured implementation target remain available. |

The separate-producer arm isolates aggregation rather than reproducing the old
upward-only implementation routing. A historical-source comparison must pin its
source revision and report that routing-policy difference as a confounder.
Do not add a production legacy-routing switch merely to run the baseline.

## Reproducibility and quality

Use the repository's `evals/` harness, authored cases, versioned fixtures and
deterministic verifiers. Keep source/package hashes, fixture identity, model
scope, initial defaults, prompts and acceptance checks equivalent across arms.
Use a persistent RPC root session: one-shot discovery skips and an explicit
`--thinking` override would otherwise bypass the decisions being measured.

Representative scenarios cover routine work with existing context, discovery
across unknown independent surfaces, complex planned implementation, and manual
selection/recovery. Grade task outcomes first, then routing and phase behavior:

- Known context does not cause redundant discovery.
- Discovery guidance refers only to available roles and respects active work.
- Planning inference does not run below the capable high-effort floor.
- A stronger implementation recommendation does not override the configured
  model or effort. Same-provider fallback is recorded rather than represented
  as a cheaper-model handoff.
- Manual choices remain authoritative; temporary automated ownership releases
  and subsequent ordinary routing resumes when appropriate.
- Verification runs after edits, and failures or unresolved work are not
  counted as completed tasks.

Record fallbacks, timeouts, unavailable profiles and interventions. Exclude
failed or non-equivalent tasks from savings comparisons, but retain their
failure rates in the quality report. If child execution or usage cannot be
accounted for, label the run incomplete for combined-cost comparison; advisory
routing correctness alone does not establish delegation savings.

## Measurements

Report actual provider-request counts, classifier and coding-agent tokens,
available reasoning/cache usage, combined classifier-plus-parent/child cost,
first-output latency, phase-transition timing and end-to-end duration. Count a
shared request's usage once, not once per consumer. Missing pricing or usage is
unknown, not zero. Catalog-priced API-equivalent estimates are not subscription
charges or verified invoiced costs.

First-output latency must come from an observed streamed output delta. Neither
`turn_start` nor classifier completion is a first-token observation; record
missing streaming evidence as unavailable. Preserve individual trials before
reporting distributions, and do not draw percentile conclusions from a handful
of samples.

Do not retain credentials, authorization files, raw reasoning or unrestricted
session transcripts in benchmark artifacts. Keep historical `evals/results/`
evidence immutable. Offline tests use fake inference and validate orchestration,
metrics and grading; they are not provider performance measurements.

## Execution policy

The 2026-10-07 comparisons were explicitly authorized and ran all four
benchmarks concurrently. Before any future provider-backed run, obtain separate
authorization specifying providers, trial count and budget; build a current
source image with the existing evaluation workflow. Token or request reduction
alone is not a savings claim.

The [case guide](../../evals/cases/turn-classification/README.md) defines the
schema-v1 evidence, deterministic grading and future live-run commands. The
`turn-classification-evals.yaml` catalog lists four scenarios and six arms:
disabled/shared/separated with Sol and with Luna as the initial model. The Luna
lane also exercises promotion to a capable planner. Use these offline checks:

```sh
pnpm --dir evals test
pnpm --dir evals run list --config turn-classification-evals.yaml
```

The catalog's `turn-classification` and `turn-classification-luna` benchmarks
compare against disabled inference; their `-transport` variants isolate
aggregation against separated producer requests. Listing an existing recorded
image does not establish that the image contains the new candidate; rebuild
from the final source before any separately authorized provider run.
