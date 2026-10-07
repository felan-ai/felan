# Turn-classification live-run failure analysis

The four authorized provider benchmarks ran concurrently on 2026-10-07 against
`felan-evals-source:1e725bd8e4f3d1497f7ca7d8` (source commit
`d43400060d99167feea16dbe3ec723c06655a9d8`, dirty). Across 96 trials, 65 passed
and 31 failed. Quality gates failed, so these trials do not support a cost,
latency or savings conclusion. Subscription USD costs were unavailable; running
all four benchmarks concurrently also confounds latency.

| Scenario | Passed |
| --- | ---: |
| Routine fix | 24/24 |
| Manual override and recovery | 24/24 |
| Broad discovery | 17/24 |
| Planned implementation | 0/24 |

| Arm | Passed |
| --- | ---: |
| Sol disabled | 9/12 |
| Luna disabled | 8/12 |
| Sol separated | 9/12 |
| Luna separated | 7/12 |
| Sol shared | 18/24 |
| Luna shared | 14/24 |

The per-run regrade is in
[`turn-classification-failure-analysis.json`](turn-classification-failure-analysis.json).
It references the original run artifacts and contains only safe assertion,
phase/profile, model/effort and expected/actual fields. Original results,
rewards and project trees were not changed.

The retained run records do not identify the exact `harness-evals` package
version used for each trial. The current local evaluator's
`evals/node_modules/harness-evals` symlink targets the sibling checkout at
`0.2.18`; `evals/package.json` and its lockfile still pin registry `0.2.16`.
The 96-run results must not be retrospectively attributed to either version.
The local `0.2.18` is a backward-compatible patch and remains unpublished.

These runs were launched concurrently across all four benchmarks. Failure
counts and deterministic verifier outcomes are direct evidence; latency
comparisons are confounded by concurrent load. Subscription USD costs are
unknown, so neither requests nor token counts establish savings.

## Findings

Failure checks overlap; they total 35 findings across 31 failed runs. The
business, protected-file and phase-profile findings below have high confidence:
they come from retained project trees and observed inference metadata. Root vs
child attribution for driver failures has no retained evidence and remains
unknown.

- **High confidence — 23 implementation trials:** `checks.mjs` changed although the fixture only
  permits changes to `billing/tax.mjs`, `shipping/fee.mjs` and
  `orders/quote.mjs`. The changed smoke-check file itself was protected, so the
  verifier correctly rejected these runs.
- **High confidence — one implementation trial:** the order quote charged `$5.00` shipping at a
  `$50.00` US subtotal. Expected shipping was `$0`; actual was `$500` cents. The
  fee boundary is strict `>` while the fixture requires free shipping at
  `>= $50.00`.
- **High confidence — two discovery trials:** `shippingUS` was emitted as a description object or
  prose string rather than the required numeric `500` cents.
- **High confidence — four discovery trials:** root planning used Sol at `max` effort. The pinned
  benchmark profile accepts `high` or `xhigh`, so this is a phase-profile
  mismatch. Decide whether `max` should be accepted as a stronger equivalent or
  constrain routing to the declared profile before another run.
- **Unknown cause — five trials (one discovery, four implementation):** the driver recorded
  `status: failed` and exited 1. Those v1 results did not preserve whether the
  root assistant or a child failed; private session/config storage was deleted.
  Exact causes cannot be reconstructed. Four overlap the protected-file
  failures above.

The verifier failures are not all evidence of a classifier regression: most
implementation failures violate the benchmark's protected-file rule. The quote
and discovery failures are business-output mismatches; the planning effort and
driver outcomes need the follow-up decisions/evidence described above.

## Reproduce a retained verifier check without editing its original run

The verifier is network-free but imports candidate project code. Copy a retained
workspace and run it in the recorded image with Docker networking disabled;
never execute it directly on the host or modify the historical workspace:

```sh
run=turn-classification-implementation-turn-classification-disabled-2026-10-07T06-39-01-261Z-8
tmp="$(mktemp -d)"
cp -R "evals/.harness-evals/runs/$run/workspace" "$tmp/workspace"
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$tmp/workspace,target=/workspace" \
  --mount "type=bind,source=$PWD/evals/cases/turn-classification/commerce/verifier,target=/tests,readonly" \
  felan-evals-source:1e725bd8e4f3d1497f7ca7d8 \
  node /tests/verify.mjs implementation
cat "$tmp/workspace/.eval-output/verifier-diagnostics.json"
rm -rf "$tmp"
```

The failed-run diagnostics are
`workspace/.eval-output/diagnostics.json` and
`workspace/.eval-output/verifier-diagnostics.json`. New runs retain these
sanitized artifacts while the harness always removes run-owned config and
credential copies, regardless of `--cleanup`. The original persistent auth
profile is not deleted. `--cleanup` removes only registered adapter cleanup
paths; it does not remove the retained workspace or these diagnostic artifacts.
Historical v1 trials predate the first artifact and have only the structured
result/phase records and final project tree; five driver failures therefore
cannot be attributed to root versus child failure from retained evidence.

## Next actions

1. Fix the quote threshold and tighten the implementation prompt against editing
   unrelated smoke-test files; do not relax protected-file grading to make the
   current results pass.
2. Resolve whether planning `max` satisfies the benchmark's declared
   `high`/`xhigh` profile and make the evaluator and routing policy agree.
3. Clarify the discovery output schema for monetary values.
4. Use the new sanitized driver diagnostics to classify future root/child
   failures before considering another provider-backed run. Rebuild the source
   image and request explicit authorization before rerunning.
5. Run comparisons sequentially or document concurrency effects; require every
   business and metadata gate to pass before comparing costs or latency.
