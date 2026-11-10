# Test audit

This audit ran on November 10, 2026 with Node 22.23.4 and pnpm 9.15.5, on an
18-core Apple Silicon Mac. It covered the workspace suites, the performance
harness tests and the offline evaluation tests. Final verification did not run
provider-backed evaluations or Supabase integration tests.

## Baseline and scope

The initial inventory contained 7,725 tests in 559 workspace test files. Nine
recursive package runs all failed. Those failures included unavailable local
Supabase services and intermittent timing, process and persistence failures.
The recursive runs took 77 to 87 seconds. An initial shared-pool run took
68 to 74 seconds.

The original recursive-run reports also included a separate web-access package
smoke with two tests in one file. Their raw aggregate is therefore 7,727 tests
in 560 result files, rather than the workspace inventory above.

The review did not treat every unusual input as unnecessary. Protocol limits,
hostile input, interrupted writes, process ownership and recovery states remain
valid cases. Each proposed deletion needed a verified duplicate, an unreachable
internal path, a removed implementation, or an assertion that pinned internal
copy, structure or call counts rather than behavior. Title-only audit verdicts
were not enough to remove coverage.

## Changes to the feedback loop

- Root `pnpm test` now uses one Vitest process and a shared worker pool across
  workspace projects. Recursive package runs previously started several large
  worker pools at once.
- `scripts/test-isolated.sh` retains Corepack's package-manager cache. Isolated
  runs no longer download pnpm into every new HOME. The wrapper also removes its
  temporary HOME after successful and failed commands.
- Daemon and client Vitest configs set `FELAN_TEST_SKIP_FSYNC=1`. Production keeps
  descriptor syncs and the existing SQLite durability settings when this flag
  is unset. The persistence test exercises both modes. Never set this flag for
  a real daemon; it permits data loss after a system crash or power failure.
- Performance tests remain available through `pnpm test:perf`. The daemon's
  Supabase suites use its opt-in `test:integration` command. Neither runs during
  the default test command.
- Freshly built distribution checks run through `pnpm test:dist` in the packed
  CI job. A default web-access test run no longer rebuilds `dist` while another
  workspace may import it.
- Two central ownership tables replace scattered source-scan tests. Manifest,
  export and attribution checks remain separate. A temporary forbidden import
  made the new table fail, then the clean test passed after its removal.

## Reductions and reliability fixes

| Area | Changes |
| --- | --- |
| Dead code | Removed ten unreferenced client and extension modules, the unused browser protocol script, an unused upstream log checker and fixture, associated tests, and verified private functions or exports. Public package export maps and the tracked host configuration remain unchanged. |
| Daemon | Removed private cache and call-count guards. Smaller injected outbox capacities replace megabyte-scale capacity fixtures without changing production limits. Service and transcript fixtures use controlled processes and signals. Completion checks join delivery work. New fixture roots use the isolated temporary directory; pre-existing repository fixtures were preserved. |
| Client | Removed Markdown cache-spy and reducer serialization guards while retaining output parity and size limits. Width checks share their scenario setup. Browser relay checks await drain events. Timeout checks use controlled timers where possible. Extension fixtures no longer write workspace `node_modules`. |
| Memory | Fixture cleanup awaits coordinator disposal. Comparison cases no longer depend on execution order. Tests await worker entry, cancellation and scheduling follow-ups. Stopped process locks are aged after confirmed exit rather than through a sleep. |
| Agent Core | Finite descendant writers and readiness signals replace chatty processes and timing guesses. The shell-exit escalation case uses a controlled child and virtual time. Separate real process-group termination cases remain. |
| Session protocol, title and compaction | Removed internal schema-shape, copy and call-count checks and verified duplicates. Retained hostile prototypes, accessors, byte limits, invalid tails, cancellation and distinct ordinary versus expiry failure behavior. |
| Claude Code and Codex | Removed copy and diagnostic pins, duplicate cases and the installed-Pi layout canary. Deferred query, write and acknowledgement gates replace several sleeps. The upstream README records every removed upstream case and the retained file mapping. |
| Background bash | Controlled snapshots test foreground deadlines and aborts. PTY grace checks advance the clock instead of waiting five seconds. Input triggers late output. An explicit completion promise replaces message polling. A controlled liveness fixture replaces the seven-second delayed-exit shell matrix. |
| Other extensions | In-memory JSON-RPC handles replace Codebase Memory child fixtures. OAuth refresh, UI shutdown, Prewalk review, RTK reporting and Insights reads use entry or completion gates. Savings tests no longer pin benchmark ratios as correctness assertions. |

Several new noncompletion assertions needed another check during independent
review. A synchronous assertion immediately after attaching a promise callback
cannot prove that shutdown waits. The corrected tests keep their gates closed
through a scheduler checkpoint. Each test rejects a temporary mutation that
returns an already-resolved shutdown promise.

The first combined stress campaign also exposed the shell-exit drain fixture.
Its second root run failed with `kill EPERM` during cleanup. The replacement
tests the exited-shell, open-pipe and forced-termination states without trying
to enter a real 500 ms window. The failed campaign remains in the local reports.

## Code-mode benchmark repair

The separate offline evaluation suite exposed three failures in a stale fixture
that called removed client runtime APIs. The updated fixture starts the
canonical daemon service and adds synthetic tools through a fixture-only
provider that calls the installed local session runtime. A headless protocol
client submits the explicit model and thinking level through daemon admission.
The daemon owns activation, session storage and shutdown.

Eleven offline cases cover the shipped `off`, `on` and `only` modes, synthetic
API grades, actual migration and inventory grades, native events, usage and
failed activation. They passed three serial repetitions. The complete offline
evaluation suite also passed against fresh workspace builds. In-memory
credentials, injected model streams and a network prohibition keep these tests
offline. Historical evidence and scenario graders were not rewritten, and no
provider-backed savings result is claimed.

These offline eval runs used a local harness-evals 0.2.18 checkout linked into
`evals/node_modules`. A clean install of the locked 0.2.16 rejects the `jev`
judge key in the tracked configs and fails at the first eval test. That
mismatch predates this audit, and CI does not run the eval tests.

## Coverage kept deliberately

- All eleven distinct daemon SIGKILL recovery modes remain. They cover different
  request, continuation and transcript ordering guarantees.
- Cross-process memory ownership and abrupt-exit recovery remain. In-process
  breaker tests do not replace those cases. FIFO cases remain too.
- The emitted CLI, terminal-client death, manual PTY, focused-dialog and restart
  checks remain where they exercise behavior absent from in-memory clients.
- The aggregate stream overflow case still uses individually valid frames.
  One oversized frame would test the wrong limit.
- Delayed Chrome approval still waits beyond two seconds. It rejects a simulated
  two-second handshake timeout. Removing that wait without equivalent coverage
  had weakened the test, so it was restored.
- Browser authorization, DNS pinning, Unicode-heavy web truncation, installer
  integrity and credential redaction cases remain.
- Public Fusion and Felan API factories, the memory daemon provider, public
  options and schema aliases remain even where repository callers are sparse.
  Removing public APIs would be a separate compatibility decision.

## Measured results

| Collection stage | Test cases | Files |
| --- | ---: | ---: |
| Initial workspace inventory | 7,725 | 559 |
| Shared default suite after separating optional checks | 7,711 | 556 |
| Final working-tree default suite | 7,437 | 550 |

These are collected cases, including skipped cases. The net decrease after
separating optional checks is 274 cases. Merged cases can retain several
assertions, and the optional checks still exist outside the default suite.
The default workspace counts do not include the offline evaluation suite.

The completed checks were:

- `scripts/test-isolated.sh pnpm verify` passed, including builds, type checks,
  licenses, tests, packing and packed-install checks. It took 213 seconds; its
  test phase took 39.68 seconds.
- Nine later default-worker root runs completed before the resource-limit
  interruption. Each passed 7,418 tests and skipped 16. Wall times were 41.31
  to 55.55 seconds, with a 47.10-second median.
- The final current-tree run used two workers. It passed 7,421 tests, skipped
  16 and failed none across 550 files. It took 180 seconds. Its collected count
  includes three additional savings-dashboard cases present in the final tree.
- Changed-package campaigns passed five isolated repetitions per changed
  package. Review fixes received additional focused and repeated verification.
- Fresh serial workspace builds and type checks passed after resumption.
  Both dead-code modes passed. The seven opt-in performance tests, nine
  performance-harness tests and 24 distribution checks passed. The distribution
  checks and complete offline eval suite also passed against the fresh builds.
- Independent review found weak noncompletion assertions and lost delayed
  approval coverage. Both were corrected and checked with failing mutations.
  The benchmark rewrite's independent review found no concrete issues.

The uncapped campaign consumed too much CPU and the user stopped it during the
tenth root run. Concurrent CI-job emulation was never reached and did not run.
After approval to continue, verification used one test command at a time and at
most two Vitest workers. The slower final run reflects that resource limit; it
is not directly comparable to the default-worker timings.

These results establish passing observed runs, not proof that every possible
flake is gone. Linux-only PTY behavior and provider-backed evaluations were not
executed on this Mac. OAuth callback tests still contain a bind-close-rebind
port allocation risk, although no failure from it appeared in these runs.

The slowest individual cases in the final two-worker run were:

| Test file | Retained case | Duration |
| --- | --- | ---: |
| `packages/ext-memory/test/local/memory-shared-coordinator.test.ts` | Sealed driver failure and force settlement | 2880.92 ms |
| `apps/felan/test/tui-transcript-projection.test.ts` | Streaming-tail parity with fresh full projections | 2879.55 ms |
| `packages/ext-memory/test/local/memory-lifecycle-process.test.ts` | Shared failures, durable disablement and explicit recovery across processes | 2455.71 ms |
| `apps/felan/test/browser-connection-lease.test.ts` | Delayed approval with one consumed handshake slot | 2206.71 ms |
| `packages/ext-memory/test/daemon-provider.test.ts` | Scheduling a project created after activation | 2143.42 ms |

## Reproduction

Run daemon and client tests only through the isolation wrapper. Run the
following commands serially. The explicit worker limits keep test runs from
using every available CPU core.

```sh
pnpm -r --workspace-concurrency=1 --if-present build
pnpm -r --workspace-concurrency=1 --if-present type-check
scripts/test-isolated.sh pnpm test -- --maxWorkers=2
scripts/test-isolated.sh pnpm test -- --project @felan-ai/daemon --maxWorkers=2
scripts/test-isolated.sh pnpm test -- --project @felan-ai/felan --maxWorkers=2
scripts/test-isolated.sh pnpm run test:perf --maxWorkers=2
scripts/test-isolated.sh pnpm --filter @felan-ai/ext-web-access run test:dist --maxWorkers=2
scripts/test-isolated.sh pnpm --filter @felan-ai/felan run test:dist --maxWorkers=2
scripts/test-isolated.sh pnpm perf:test
scripts/test-isolated.sh pnpm --dir evals test
pnpm dead-code
pnpm dead-code:all
```

Local package repetition campaigns used at most two workers while other areas
ran concurrently. Their timings are not directly comparable to the original
recursive run. Workspace builds remove `dist`, so builds and packed checks
must not overlap test runs.

The local evidence is under `/tmp/felan-test-audit`. Area handoffs record exact
commands, counts, intermediate failures and retained audit corrections. Those
logs are machine-local and are not published benchmark evidence. The final
counts and timings are in `final-verification-summary.json` in that directory.
