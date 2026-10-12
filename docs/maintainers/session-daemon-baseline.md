# Story 1 baseline and feasibility evidence

Recorded 2026-10-10, starting at
`fdbf7151ae5e760e312983e9798570a9fdb001ea`. Local machine:
Darwin 25.6.0 arm64, Node `v22.20.0`, pnpm `9.15.5`, Python `3.9.6`.
The original `ext-subagents` README/source/test edits were present throughout;
this is a baseline of that worktree, not a falsely pristine HEAD checkout.

## Existing regression baseline

One complete retained `pnpm verify` log passed (exit 0): licenses, all workspace builds, all type checks,
all tests, package packing and clean-installed packed-runtime/bin checks.
The license gate validated 166 production package versions. There are 26
application/library workspaces, including 24 extensions; the workspace root is
private. Tests: **2,769 passed, 3 skipped** across 219 passed and 2 skipped files,
including the separate 2-test Web Access packed smoke. TUI: 896 passed, 1 skipped;
Agent Core: 210 passed. The six ACP files passed 57 tests; CLI/application/headless
passed 33/25/2. Per-package totals and logs are retained under
`.artifacts/story1/reviews/S1.01/`.
That retained log is the independently reviewed baseline. An earlier exit status
was observed, but its full log was removed by packing and is not counted as a
second auditable verification run. Review fixes rerun only the changed probes
and document checks, not the destructive packing pipeline.

The skipped tests are explicit: Codebase Memory's real-binary opt-in E2E (no
binary configured), the Windows/Git Bash process case (this host is Darwin), and
the memory-process worker fixture when no worker config is supplied. None is
reported as executed platform or real-service coverage.

Important coverage already present:

| Area | Baseline source/tests |
| --- | --- |
| CLI, entrypoints, session selection | `apps/tui/test/{cli,application,headless,resume,session-picker}.test.ts` |
| ACP | `acp-{server,stdio,session-registry,session-updates,interactions,login}.test.ts` |
| Runtime, env/process/files, tools | `packages/agent-core/test/{host-agent-runtime,session}.test.ts`, host `runtime.test.ts`; `ext-background-bash/test/**` |
| Extensions and presentation | Every `packages/ext-*/test`; host `extensions`, `tool-activity`, `subagent-agent-navigator`, `fusion`, `prompt-history`, `powerline`, themes and compaction presentation tests |
| Memory, children, locking | Host `memory-*`, `subagent-host`, `lock`, `pi-lock`, `model-defaults` tests |
| Browser/MCP/local onboarding | Host `browser-*`, `chrome-devtools`, `mcp-*`, `project-trust*`, `dependencies`, `dependency-onboarding` tests |
| Published application boundary | `scripts/test-packed-bin.mjs`: isolated home, exact dependencies, exports, CLI, ACP and headless runtime smoke |

These tests prove current in-process behavior, **not** R1–R5/R10 daemon acceptance.
No actual user TUI, authenticated provider, browser, daemon or store was opened.
The packed install can contact npm for dependencies; it is not evidence that the
whole verification command ran with network disabled. Story 1's offline fake-
model/socket acceptance is S1.15 work.

### Reproduction and harness cautions

Use the actual pnpm 9.15.5 executable and a disposable home/agent/temp directory,
with an otherwise cleared environment. Retain only the executable PATH, local
locale, `CI=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and disposable paths.
The local pnpm shim originally tried to find pnpm under the disposable HOME and
failed. The corrected run used the already-installed 9.15.5 executable plus
`npm_config_manage_package_manager_versions=false`.

The license command also needs the installed dependency store's index. Preserve
its location using `npm_config_store_dir` (captured before changing HOME); do not
copy credentials or run an unrelated install to hide a missing-index error.
The initial isolated attempt reported `ERR_PNPM_MISSING_PACKAGE_INDEX_FILE` until
the correct existing store location was supplied. Both were harness setup
failures, not product test failures; the corrected full suite passed.

`scripts/pack.mjs` removes the entire `.artifacts` root. Keep test output and a
temporary mirror of review evidence outside it until packing finishes, then
restore `.artifacts/story1/reviews/S1.01`. No baseline check requires live user
config/storage. Record failed checks, not just the final successful command.

## Executed disposable feasibility probes

**Environment scope update:** the user subsequently chose one fixed daemon
launch environment for all sessions. The per-session env probes below are
historical feasibility evidence, not current acceptance requirements. No provider
patch/fork/worker or authoritative getEnv API is required. Current gates are
startup-only PI_*/HTTP proxy configuration, explicit session cwd, independent
model/config registrations and no environment/control-secret disclosure.

Run from repository root after the baseline build. Both probes delete their
disposable stores/processes on completion; no credentials or network are needed.

```sh
/usr/bin/python3 docs/maintainers/probes/session-daemon-os.py
(
  probe_root=$(mktemp -d) || exit 1
  trap 'rm -rf -- "$probe_root"' EXIT
  mkdir -p "$probe_root/home" "$probe_root/tmp"
  env -i PATH="$PATH" HOME="$probe_root/home" TMPDIR="$probe_root/tmp" \
    FELAN_S1_DAEMON_ONLY=synthetic-daemon \
    node docs/maintainers/probes/session-daemon-env.mjs
  env -i PATH="$PATH" HOME="$probe_root/home" TMPDIR="$probe_root/tmp" \
    node docs/maintainers/probes/session-daemon-inventory.mjs --include-cli
)
```

| Probe | Locally observed result | Does not prove |
| --- | --- | --- |
| Kernel `flock` | A second process is refused while owner runs **or is SIGSTOP-paused**; alias resolves to same inode; SIGKILL releases ownership. | Windows semantics, network filesystems, whole process-tree fencing. |
| Unix socket | Private 0700 directory, 0600 socket, round-trip bytes, `getpeereid` reports current UID/GID. | A different OS user was denied; that negative test still needs CI/native harness. |
| Replaced lock pathname | New inode can be locked despite the old inode's held lock. The probe asserts this counterexample. | A lock alone detects path replacement; production must monitor identity and stop admission. |
| Node 22 public APIs | `fs.flock` and `net.Socket.prototype.getPeerCredentials` are absent. | A production Node implementation can use imaginary APIs or Python as an undocumented dependency. |
| Explicit Node spawn + PTY | Concurrent A/B cwd/PATH/proxy/marker inputs stay separate; daemon sentinel absent. | Current `HostAgentRuntime` already uses replacement environments. |
| Pi `ModelRuntime.getAuth(...,{env})` | Two concurrent synthetic OpenAI keys resolve independently without a provider/network call; global env/cwd unchanged. | Availability, virtual routing, AWS/other SDKs, OAuth, config-header or credential-command isolation. |
| Registered provider | Public `registerProvider` plus `getAuth` resolves a synthetic configured provider under two explicit environments, without network. | Every dynamically registered provider honors the host environment or has no global state. |
| Historical `getEnv` contract fixture (superseded) | Legacy absent-accessor fallback, mandatory daemon accessor, authoritative undefined/empty values, and forwarding by child/wrapper passed during the earlier investigation. | No such production accessor is required or implemented under the shared-launch decision. |
| Unix socket path limit | Darwin accepts a 103-byte pathname and rejects 104 in the disposable probe. | Linux/Windows path limits were run here. |
| Current host shell env | Supplied env still inherits daemon sentinel. | Safe per-session env exists today; constructor/process paths need adaptation. |
| Pi config resolver | Missing supplied keys fall back to daemon `process.env`; `!command` uses daemon env even when a client env is passed. | Passing `env` only to `getAuth` fixes configured credentials. |

The env probe imports Pi's private config resolver **only as test evidence**;
production code must use supported interfaces or an explicitly reviewed pinned
adapter exception. S1.05's `daemon/process-bootstrap.ts` is such an exception:
it resolves Pi 1.1.0's shipped `dist/core/http-dispatcher.js`, guards its expected
exports and configures it only at daemon startup. This is not a public Pi export;
like `pi-lock.ts` and the existing InteractiveMode internals, it requires review
when the pin changes. Source tests cover calls/arguments/retry and a separately
gated real-adapter smoke covers module resolution. Raw probe outputs contain only synthetic inputs and boolean
results. No real process environment dump is retained.

## Shared launch-environment adaptation

The earlier proposed per-session HostAgentRuntime/getEnv/materialized-provider
adaptations are superseded. Host subprocesses and providers keep normal ambient
launch-environment behavior. Initialize PI_* host settings and the HTTP dispatcher
once at daemon startup. Changing `httpProxy`, `httpIdleTimeoutMs` or launch environment requires daemon
restart, not a session reload. Session tool cwd remains explicit; never mutate
process cwd per session. Pi credential commands use the daemon cwd because that
upstream path exposes no per-session cwd input.

The historical investigation found ambient auth/header/SDK/proxy reads. Its
credential-cache detail is corrected: models.json command values are uncached;
auth.json API-key commands use the process-global command cache through
`auth-storage.js::read`. These facts no longer block the shared-env design.
Standard auth.json locking/refresh and all provider behavior must remain intact.
Per-session ModelRuntime/config/extension registrations still require independent
views; shared OS environment does not authorize mutable model-state sharing.

MCP clientSecretEnv, browser discovery, memory git and portable extension env
lookups may use the daemon environment. Do not introduce a new portable accessor
solely for future isolation. Endpoint/control tokens must never be added to the
process environment inherited by tools or to model-visible data.

`apps/tui/src/extensions.ts` and some extension defaults mix execution and
presentation. S1.05 extracts the pure catalog/local profile seam; S1.09 owns the
remaining built-in execution/presenter split and optional llama UI integration.
The profile must receive daemon-owned bindings, not import terminal composition.

## Inspected process and descendant lifetime baseline

These are source observations, not newly executed daemon tests:

| Current path | Observed behavior | Story 1 contract / owner |
| --- | --- | --- |
| `ext-background-bash/src/index.ts:316–369` | Bash starts a runner/PTY; abort during its foreground wait explicitly stops that job. Once returned/promoted, the tool no longer retains an abort listener for it. | Cancel preserves this distinction: stop the still-foreground operation, not every previously launched job. S1.06/07. |
| `ext-background-bash/src/process-manager.ts:99–151,423–458` | Ordinary background work uses a persisted runner and `nohup`/detached process group. | Already detached jobs survive client and daemon stop; persist/reconcile their IDs/tokens/output, never launch a replacement merely because the daemon restarted. S1.04/06. |
| `ext-background-bash/src/index.ts:580–584`, `coordinator.ts:139–164` | Session shutdown stops interactive PTYs when it owns the coordinator, not detached nohup jobs. | Detach must not call shutdown. Close/host stop settle foreground processes/PTYs; explicit process stop is how to terminate detached jobs. S1.06/14. |
| `apps/tui/src/subagents/host.ts:621–680,1127–1190` | Explicit child cancel recursively marks descendants and requests cancellation; its public call need not await cleanup. Manager shutdown waits on child jobs. | A terminal cancellation record is not proof of process exit. Explicit child cancellation retains its tree scope; close/stop verify cleanup before disposing. S1.06/14. |
| `ext-subagents/src/session-binding.ts`, child runner in `subagents/host.ts:910–1080` | Parent binding detaches on session disposal; child input signal aborts that child's session. No inspected hook turns a root prompt abort into blanket cancellation of independently spawned children. | Preserve independently spawned child sessions on ordinary root run cancel; explicit `cancel_subagent` cancels the tree. S1.06/07. |

Graceful host stop persists known detached-job identities and stops daemon-owned
foreground/PTY/child execution. Restart reconciles known detached runners using
their existing identity checks; it never reports them stopped simply because
the daemon exited. Unresolved launch/identity ambiguity blocks affected writes.
Detached runner output/status files are an explicit delegated writer exception,
not permission for a second session/memory/task writer. Closed sessions retain
job history but must not start completion-triggered turns. Eviction can release
runtime-independent detached jobs only if the daemon retains their watcher,
policy and durable continuation state. The shared environment remains process-owned.

`savings-command.ts::runLocalSavingsCli` constructs a HostAgentRuntime before
querying. S1.13 must prove the complete constructor/query path is read-only or
route the CLI through the daemon; no exemption follows merely from its name.

## Explicit remaining gates, not unrun success claims

1. **S1.03:** select/audit a maintained native lifetime-lock/peer-identity/Windows
   ACL binding or a small packaged native helper. Existing `lock.ts`/proper-lockfile
   are heartbeat leases and insufficient for process ownership. No new native
   dependency was added by S1.01. Prove Node-facing integration, cross-user denial,
   crash/stale/replace races, prebuild/install/pack/license behavior and process
   termination on every supported OS. Darwin kernel feasibility passes;
   Linux/macOS x64/Windows runners were unavailable here and remain release gates.
   Windows requires equivalent pipe DACL/token identity and lifetime locks, not a
   blanket success based on POSIX probing. Do not silently drop a supported OS.
2. **S1.05/09:** use the shared daemon launch environment without per-session
   global mutation; preserve provider/credential behavior and separate session
   cwd/config/model registrations. Prove startup-only proxy setup and require
   restart for proxy changes. The original per-session environment isolation
   blocker is superseded by the user's explicit scope change.
3. **S1.15/16:** real multi-process Story 1 acceptance, offline network denial,
   forced/interrupted recovery, safe adoption/downgrade and packed client-only
   entrypoints. Also run the real private HTTP bootstrap and `./daemon-profile`
   import in a packed install against the pinned Pi version; the source smoke
   (`FELAN_TEST_DIST_SMOKE=1` after build) is not a packed-install substitute.
   These are not implemented by baseline documentation.
4. **Release:** bootstrap the new protocol package at `0.0.0` and configure its
   trusted publisher manually before intended CI release, per
   [releasing](releasing.md). This session authorizes neither publishing nor
   modification of live daemons/stores.
