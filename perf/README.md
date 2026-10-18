# Daemon and TUI performance

A local, synthetic performance suite. It never reads existing sessions or connects to the account daemon. It uses the **current built output**, not TypeScript source.

## Run

Prerequisites: Node **22.20.0**, pnpm **9.15.5**, Python 3, and a POSIX system with `ps`, Unix sockets and PTYs (macOS/Linux).

```sh
pnpm install
pnpm build
node perf/run.mjs --quick
node perf/run.mjs                 # longer samples, 30-turn TUI history
node perf/run.mjs protocol daemon # selected suites
pnpm perf --quick
pnpm perf:test
```

Suites: `protocol`, `daemon`, `transport`, `fanout`, `e2e`, `tui`, `idle`. Shell shortcuts `perf/run-e2e.sh`, `perf/run-tui.sh`, and `perf/idle-cpu.sh` accept the same flags. `--quick` still runs every suite, but reduces samples, tokens, idle observation, and the TUI history variant from 30 to 2 seeded turns. Do not compare quick and full runs as identical workloads.

Each run prints a table and writes `perf/results/<timestamp>-<pid>.json`. The JSON records the git SHA, dirty flag, Node version, machine/OS, run options, units, sample counts and available quantiles. `value` is the arithmetic mean for tight-loop microbenchmarks and p50 for sampled distributions. A failed case does not stop other cases or suites; any failure makes the final exit status nonzero. Missing optional dependencies report `skip`. An absent/broken built module affects its suite or sub-benchmark, not the entire run. Rebuild and rerun after concurrent `dist/` rebuilds finish.

```sh
node perf/compare.mjs perf/results/before.json perf/results/after.json
pnpm perf:compare perf/results/before.json perf/results/after.json
```

Comparison reports percentage change in `value`; **positive means larger, not necessarily worse** (throughput increases are good). It warns about machine, runtime, quick/full and profiling differences. Repeat runs and inspect distributions before attributing changes to code.

## Metrics and methodology

| Suite | What it measures |
| --- | --- |
| `protocol` | JSON stringify/parse, frame encoding/decoding, schema/boundary validation, TypeBox interpreted/compiled checks, string helpers, and actual client reducer updates. Small and exactly 5 MiB snapshots use the same deterministic mixed-text history. Reducer stream updates check the state remains live; decoder round trips are checked. |
| `daemon` | SQLite WAL transaction and COMMIT-only latency for `FULL-fullfsync`, `FULL` without fullfsync, `NORMAL` without fullfsync, and `shipped`: NORMAL with fullfsync and checkpoint_fullfsync enabled, matching the control store. All cases use `busy_timeout=1000` and the default `wal_autocheckpoint=1000`. Each transaction does BEGIN + a small prepared UPSERT + COMMIT on a fresh database. JSON records include the pragmas and SQLite version. Catalog parse/hash, snapshot capture primitives, and control-state clone costs are also measured. `accounting.*-reference` compares prefix remeasurement against incremental byte counting; these are **reference algorithms**, not calls to the daemon's private delta implementation. `capture.*` measures validation/encoding/page-budget primitives, not an entire live projection snapshot. |
| `transport` | Sequential echo RTT over Unix, TCP (TCP_NODELAY) and WebSocket (no compression). Server runs in a separate process. Burst delivery compares one write per delta with roughly 64 KiB batches; full runs deliver 50,000 logical deltas, quick runs 5,000. Throughput counts logical deltas, not writes. JSON generation/parsing and client event-loop work are included. This is not the production transport stack. |
| `fanout` | Actual `SessionFanout` sends 500/1023/1025/3000 contiguous deltas through a real Unix socket. Records logical characters, wire frames, pending frames and closure reason. Merging can reduce frame counts. Historical `resync_required` is an observation, not automatically a harness failure; truncation, wrong offsets or unexplained missing text fail. Timing includes 5 ms completion polling, so use this primarily as a burst-correctness probe. |
| `e2e` | Real isolated daemon/client: launch + hello, warmed `host.status` / `sessions.list` RTT, session creation, empty/history attach, prompt acknowledgement, first token, per-token provider-to-client-state latency, and `set_thinking`. Three turns check that every emitted marker reached client state. Commit count/duration is grouped into request windows using a daemon-only SQLite COMMIT / explicit fsync preload. Windows count COMMIT **start** times; they are not causality tracing. The synchronous logger itself adds overhead. |
| `tui` | Real CLI in a 220×60 Python PTY, answering standard device, cursor, cell-size and color queries as an xterm-like terminal without Kitty keyboard support. Startup ends when a Fake/fake-model footer appears, excluding earlier setup/session creation. A warm-up turn dismisses startup selection dialogs. Measures editor echo at idle and during fresh token output, submit-to-first-token, and marker emission-to-PTY arrival on empty and seeded history. Echo waits for the typed marker sequence rather than treating arbitrary streaming bytes as acknowledgement. Every expected streaming marker must be observed; incomplete tails fail rather than silently lowering percentiles. |
| `idle` | Daemon CPU time change from `ps`, with one detached session and no clients, divided by elapsed wall time. Percent is relative to **one core**, not the whole machine. Full observation is 20 seconds after a 3-second settle; quick is only 2 seconds after 0.5 seconds. `ps` time resolution makes very small results noisy or zero. |

`fixtures.mjs` uses a fixed xorshift seed (`0x5eed1234`), fixed timestamps/IDs and 30 four-message turns: user, assistant thinking/tool call, tool result, assistant answer. Text mixes ASCII, CJK, emoji, combining characters and newlines. The large fixture pads tool results deterministically to exactly 5 MiB of JSON. No personal transcript, network model, or credentials are used. The TUI's real session IDs/timing are necessarily nondeterministic, but prompts and token counts are controlled.

Microbenchmarks warm each function three times; SQLite drops 100 warm-up transactions before 1,000 measured transactions per case (quick: 10 warm-up, 40 measured); transport drops fifty echo round trips; e2e drops three status/list round trips; TUI runs one warm-up prompt. Session creation and TUI startup are intentionally not warmed within each sample. The launch measurement is not an OS disk-cache cold start. Quick mode is a smoke measurement, not a statistically sound baseline.

### Fake provider and optional profiling

`fake-provider.mjs` binds only loopback, implements the OpenAI-compatible streaming chat-completions endpoint, and stamps every token with epoch milliseconds. Client and PTY observers deduplicate these markers. It emits at least 1 ms apart, including seed turns, to avoid overflowing older fanout implementations with a synchronous seed burst.

```sh
ASCII_MARK=1 node perf/run.mjs tui --quick   # zz<time>zz instead of ⟦<time>⟧
SEED_TURNS=30 node perf/run.mjs tui --quick
FAKE_TOKENS=600 FAKE_INTERVAL_MS=10 node perf/run.mjs e2e
node perf/run.mjs e2e --profile
node perf/summarize-profile.mjs perf/results/<id>-daemon.cpuprofile 6000
node perf/modules.mjs perf/results/<id>-daemon.cpuprofile 6000
node perf/callers.mjs perf/results/<id>-daemon.cpuprofile functionName
```

`--profile` enables a daemon-only 200 µs V8 CPU sampling profile, saved with the run artifacts. `count-commits.mjs` is always used in e2e; `daemon-prof.mjs` is optional. Profiling alters timing; compare profiled and unprofiled runs separately. Profile analysis is heuristic, and the optional time window is milliseconds from profile start, not prompt start.

## Isolation and cleanup

The runner creates a short `/tmp/fpb-*` root per suite and starts the worker with a clean environment: fresh `HOME`, `FELAN_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `TMPDIR`, and all four XDG directories, plus offline/version-check flags matching `scripts/test-isolated.sh`. It does not inherit credentials, `NODE_OPTIONS`, agent settings or compile-cache state. Short roots avoid macOS Unix socket path limits. Runtime and working directories are always inside that root.

Workers have a 90-second quick / 300-second full deadline. After worker exit, the runner first attempts `host.stop force` through a separate client with daemon launching disabled, while the runtime still exists. It then sends TERM, waits up to 3 seconds, and sends KILL if necessary, **only** to recognized benchmark processes whose `ps -A -o pid=,args=` arguments include that suite's exact runtime directory. Providers and CLI children carry this directory in their arguments. Python additionally terminates/reaps its own PTY child in `finally`. Removing a live daemon's directory can make it ownership-lost/blocked and resistant to TERM, so deletion is always last. Cleanup checks all process arguments for the root before deleting it, and rechecks for late filesystem writes. JSON `isolation` records report each root and its final process/directory state. Artifacts alone remain under gitignored `perf/results/`. Normal completion, handled interrupts and timeouts are covered; SIGKILL/power loss cannot run cleanup. Do not manually kill broad name matches or delete other runs' roots.

## Interpretation limits

- PTY timing is **when bytes reach the PTY**, not terminal paint, display refresh, or perceived UI responsiveness. ANSI rewriting can split/duplicate markers; collectors retain recent text and deduplicate complete markers. Font/wcwidth differences can affect non-ASCII markers; use `ASCII_MARK=1` to investigate.
- This is a fake provider on one machine. It excludes real provider/network latency, model reasoning, remote connectors and billing. Token stamps contain measurement overhead and use the local wall clock; clock changes can invalidate samples.
- Scheduling, thermal/power state, other builds, filesystem cache, SQLite checkpointing, APFS behavior and instrumentation add noise. fullfsync effects are platform/filesystem dependent; PRAGMA configurations are labels, not guarantees of disk durability.
- Internal reducer, fanout and client-entrypoint imports are intentionally narrow but not public contracts. API drift must be reported as failures/skips rather than silently benchmarking a replacement algorithm. Public protocol entrypoints and declared-consumer dependency resolution avoid pinned pnpm store paths.
- Historical investigation results in [baseline-bca187a.md](baseline-bca187a.md) used different fixtures/harness code. They are context, **not a directly comparable golden threshold**. This suite establishes reproducible baselines going forward.
