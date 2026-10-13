# Story 1 implementation handoff

Historical pre-services handoff. The services migration supersedes the profile
and presenter seams below; see [ADR 0036](../decisions/0036-configure-extension-services-through-trusted-providers.md)
and [the current guide](extension-services-and-ui.md). This document retains
the original rationale, not current release acceptance. Node `22.20.0` and
pnpm `9.15.5` remain the release toolchain.

The approved source is [shared-session-daemon/design.html](../../../felan-platform/docs/architecture/shared-session-daemon/design.html),
especially `#delivery`, `#protocol`, `#extensions`, `#guarantees` and R1–R5/R10.
The relative link requires the sibling `felan-platform` checkout. The task graph
is the execution order; this document fixes integration seams, not new scope.

Read with:

- [Protocol and profile contracts](session-daemon-contracts.md).
- [Actual command, extension and presentation inventory](session-daemon-inventory.md).
- [Baseline, probes and remaining platform gates](session-daemon-baseline.md).
- ADRs [0020](../decisions/0020-own-local-session-protocol-and-stores.md),
  [0021](../decisions/0021-bind-daemon-environments-through-profiles.md),
  [0022](../decisions/0022-shared-daemon-launch-environment-and-explicit-lifetime.md),
  [0023](../decisions/0023-retain-acp-approvals-in-daemon-policy.md).

The subsequent distribution decision is recorded in
[ADR 0025](../decisions/0025-separate-daemon-and-client-distributions.md).

## Fixed scope and user decisions

- One persistent production daemon per OS account; the target `apps/daemon`
  owns it and the local profile. `apps/felan` owns the CLI/TUI and protocol
  clients. Existing `apps/tui` paths below describe the pre-split work, not the
  final package boundary.
  Agent Core stays portable. The Felan TUI is an independent protocol client,
  not a proxy implementing Pi's `AgentSessionRuntime` for `InteractiveMode`.
- TUI, ACP and headless are daemon clients. No production client opens stores or
  executes a local runtime. Failure to connect is an error, not permission to
  start an in-process runtime.
- No account, PAT, connector, publication, web/chat, cloud profile, Supabase,
  platform backend or crash-resumable execution in Story 1. R4 covers TUI and ACP.
- Preserve ACP text/resource-link prompts, load/replay and unsafe-tool approvals.
  No new read-only/fork restriction, mode API, editor filesystem/terminal use,
  image capability or client-provided MCP process execution.
- **Superseding user decision:** every session uses the daemon's fixed launch
  environment. There is no client environment transfer, provisioning or refresh.
  Restart under a different environment to change it. Initialize PI_* settings
  and the HTTP proxy dispatcher once at process startup; `httpProxy` changes
  require restart. Keep session cwd/config/model registrations independent and
  never mutate process.env/cwd per session. Environment and credential values
  must not enter journals, events or raw logs; endpoint/control secrets must not
  be inherited by tools. The earlier per-session isolation requirement is
  historical, not an implementation gate.
- Headless/CI uses the same persistent daemon. Completion detaches; CI explicitly
  selects and stops its own isolated namespace using pinned instance/root
  identity, never production discovery. See the explicit
  [target contract](session-daemon-contracts.md#production-and-isolated-runtime-targets).
  No idle self-termination is inferred from zero clients.
- Only registered daemon sessions are visible or resumable. Explicit import
  copies pre-daemon history to a new ID without changing the source.

## Completion evidence and limits

S1.15 recorded 3,941 passing assertions with 3 declared skips across 352 file
executions, including the literal `pnpm verify` gate. Daemon-only packaging
covered 27 packages without the client, and two foreground start/stop/ownership
cycles passed. This is Story 1 local-daemon evidence, not publication evidence
or an independent review.

Three user-approved historical test exceptions remain unfixed. They are bounded
known risks, not a general waiver. Linux arm64 verification is documented at its
actual scope; Windows remains deferred and must not be represented as tested.

## Acceptance matrix

Each row needs an offline deterministic fixture, not an actual paid model call.
S1.15 owns end-to-end evidence; earlier tasks own the unit/integration gates below.

| Requirement | Owning components/tasks | Required observation |
| --- | --- | --- |
| R1: separate detach/cancel/close/evict/stop | Registry S1.06, admission S1.07, management S1.14, clients S1.11/13 | Exit during a tool/PTY leaves work alive; reattach sees it. Cancel aborts the addressed run/foreground operation, not independent spawned child sessions or detached jobs. Explicit child cancellation walks its descendant tree. Close/stop settle owned foreground work/children/PTYs while preserving and reconciling independent detached jobs. Eviction is only idle runtime disposal. See the inspected lifetime table in the baseline. |
| R2: convergence | Protocol S1.02, projection S1.06, server S1.07, reducer S1.10 | Two independently connected clients agree on active branch/transcript, retained active text/thinking prefixes, model/thinking, queue, tool/process/child states, interactions and run origin. Mid-message attach uses an atomic stream-offset cutover; unrecoverable prefixes wait for completion rather than resnapshot-loop. |
| R3: retry safety | Store S1.04, admission S1.07 | Lost ack + identical ID returns recorded outcome; changed payload conflicts; expired ID is rejected. Crash at each intent/dispatch/outcome boundary never causes a second execution. Ambiguity is visible as `indeterminate`. |
| R4: one answer, despite detach | Broker S1.08, adapters S1.09/11/13 | TUI and ACP race: one authorized, schema-valid answer wins and both see resolution. EOF leaves pending. Timeout, cancellation, unsupported presentation, drain/defer and answer-before-crash are distinct. ACP load while busy still attaches/replays; prompt returns typed busy until strict policy activates with no in-flight turn/tool call or admitted dispatch across the session/root scope, including child turns. Detached jobs, PTYs and idle children do not block activation; future controls are gated calls. Blocker IDs/reasons are visible, explicit activation waits are capped at 30 seconds and blocker cancellation stays available. |
| R5: offline local | Profile S1.05, all clients, S1.15 | With no Felan/provider credentials and network denied, a fake model completes create/run/detach/reattach/resume. Readiness never requires update, provider, account or platform calls. Missing real-model credentials give a useful local error. |
| R10: daemon owns descendants | S1.05/06/09/14 | Root and nested children, memory work, bash jobs and PTYs are tracked in the owner; client exit does not dispose them. Another client can inspect/control authorized resources. Restart reports interrupted/missing resources and does not recreate a shell, PTY or child execution. |
| Ownership/security prerequisite | S1.03/04/07 | Concurrent starters, aliased/custom/overlapping stores, PID reuse, paused owner, replaced endpoint/lock inode, forged readiness and cross-user denial. No second current-version writer. |

## File ownership and parallel work

### Distribution split and revised execution order

The user added **S1.07a (`T-4488B1`)** after S1.07 and before S1.08. The plan
therefore has **17 implementation tasks**, plus separately counted support and
tracking tasks. Complete and verify S1.07 at its current paths first. S1.07a
then transfers the existing work into `apps/daemon` (`@felan-ai/daemon`) and
`apps/felan` (`@felan-ai/felan`); it does not rewrite completed behavior.

The CLI/TUI distribution depends on the exact daemon package version, resolves
its installed entrypoint, and retains version negotiation. The daemon never
depends on the Felan client. Local installation stays a single user action;
cloud installations need only the daemon and their profile. Initially both
packages release together. The pinned Pi SDK's transitive `pi-tui` dependency
must be disclosed, not confused with a dependency on the Felan CLI/TUI.

After S1.07a, interpret the historical ownership table as follows:

- S1.08: broker and continuation code in `apps/daemon`.
- S1.09: environment/execution and broker adapters in `apps/daemon`, client
  adapters in `apps/felan`, presenters in their existing extension packages.
- S1.11–S1.13: TUI, local consent/onboarding UI, ACP and headless clients in
  `apps/felan`; authorized host effects remain in `apps/daemon`.
- S1.14: service entrypoint/drain/restart in `apps/daemon`; management commands,
  launcher and TUI controls in `apps/felan`. Do not duplicate lifecycle logic.
- S1.15: verify both distributions, daemon-only installation, one-way imports
  and the combined local installation, without implementing the cloud profile.
- S1.16: inspect both manifests/exports and exact dependency versions; add the
  daemon package to release, license and packed-install coverage. Follow new
  package bootstrap/trusted-publisher requirements without publishing here.

S1.07a owns the move/import map, package and build wiring, profile API migration,
scoped instructions and verification path updates. It must hand off these paths
before dependent tasks start. Moves invalidate source manifests and test
authorizations: preserve old evidence and capture new reviewed manifests rather
than reusing an approval for the former paths.

S1.07a establishes the application/package boundary; S1.09 owns the subsequent
extension execution/presenter separation. Do not implement that migration twice.
Check the complete no-presenter-import boundary after S1.09, before release.

### S1.07a candidate path handoff

The application files now live in `apps/daemon` and `apps/felan`; the historical
table below is retained as provenance, not a set of current import paths.
The exact before/after map, working-copy snapshots and static results are in
`.artifacts/story1/reviews/S1.07a/`. Isolated verification must regenerate its
source manifest from these paths; old runner approvals do not transfer.

- Daemon server, registry, ownership, persistence and profile modules retain
  their basenames under `apps/daemon/src/daemon`; local resources/settings,
  subagents and memory scheduling/storage also live in that application.
- CLI, TUI, ACP, headless, protocol client and legacy runtime composition live
  in `apps/felan/src`. The legacy composer is intentionally retained until
  S1.11/S1.13; this candidate does not claim a completed client cutover.
- Mixed extension execution/presentation modules remain in the daemon until
  S1.09. Its internal exports support the existing client composer. The client
  passes its version into the mixed powerline importer; the daemon never reads
  or imports the client package to obtain that presentation value.
- The client depends on `workspace:0.1.0` of the daemon, which packs to an exact
  dependency, and resolves its installed package entrypoint. The root entrypoint
  is currently importable, not a standalone service command; S1.14 owns that
  startup behavior and continues to own management commands.
- The unchanged profile API version 1 moved from the client to
  `@felan-ai/daemon/daemon-profile`. S1.16 must account for this breaking export
  move, the client version/dependency change, all internal exports, coordinated
  release and new-package bootstrap. Neither distribution is release-ready.

### Working milestones and current review policy

Track delivery as six outcomes: verify the server; split the applications;
implement questions and approvals; connect the TUI and extensions; connect
ACP/headless and daemon controls; verify workflows and prepare release. The
numbered tasks retain dependency and ownership details. Support tasks and old
review findings are not additional product requirements.

The user has paused code reviews for now. Continue implementation and relevant
tests without starting reviewers or claiming review approval. Reuse the approved
`scripts/test-isolated.sh` wrapper for daemon/client tests, including
`scripts/test-isolated.sh pnpm verify`. Do not use the historical freeze-checkpoint runner. Optional improvements stay deferred
unless they block required behavior, correctness or safety. Earlier per-task
review gates below describe the original workflow and are suspended by this
instruction; source snapshots, test evidence and ownership rules still apply.

Paths below are reserved output paths (new paths need not exist yet). Each task
owns its listed tests with the same basename. Existing files are edited only by
the named owner, or after an explicit handoff recorded in both task notes.
Dependencies permit sequential transfer, never simultaneous shared-file edits.

| Task | Exclusive production scope; integration edits |
| --- | --- |
| S1.01 `T-A4BB2A` | These four `session-daemon-*.md` documents, `docs/maintainers/probes/session-daemon-*`, ADRs 0020–0023, status annotation in ADR 0004. No application implementation. |
| S1.02 `T-B7380C` | New `packages/session-protocol/**`; root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `scripts/package-paths.mjs`, protocol package-list/packed/license wiring only. Sole root dependency/lockfile editor while S1.02 and S1.05 run in parallel; no app `./daemon-profile` export. |
| S1.03 `T-949435` | `apps/tui/src/daemon/{ownership,ipc,supervisor,native-ownership}.ts`; native helper assets if proven necessary; `test/daemon-ownership.test.ts`, `test/daemon-ipc.test.ts`. Owns native dependency/notice wiring **after** S1.02's manifest handoff. No registry/broker. |
| S1.04 `T-20E0D2` | `daemon/control-store.ts`, `test/daemon-store.test.ts`, fault fixtures. No new transcript backend. |
| S1.05 `T-1FD98F` | `daemon/{profile,local-profile,process-bootstrap,execution-policy}.ts`; `local-resources.ts`, `extension-catalog.ts`, `runtime.ts`, `extensions.ts`, `settings.ts`, `codex.ts`; type-only `agent-core/src/index.ts` export and focused tests. Narrow shared `safe-tools.ts` extraction and ACP import preserve existing ACP behavior. Owns only `apps/tui/package.json`'s existing `./daemon-profile` export; S1.03 holds the temporary dependency/native-build/root-lock lease. No new environment accessor or provider adaptation. Legacy `application.ts` lifecycle remains unchanged; daemon startup wiring belongs to the cutover tasks. Hands execution/presenter splitting to S1.09. |
| S1.06 `T-19A785` | `daemon/{registry,projection,processes}.ts`; `subagents/{host,store}.ts`, memory lifetime adaptations. Sequentially receives `runtime.ts`/`runtime-factory.ts` from S1.05. No `ext-subagents` overwrite: preserve original user delta. |
| S1.07 `T-66A5A5` | `daemon/{admission,server}.ts`, corresponding server/admission tests. Injected broker port only; unwired calls reject `unavailable`. |
| S1.08 `T-0FC556` | `daemon/{interactions,continuations}.ts`, broker tests; wire broker via constructor injection, not a parallel edit to S1.07 server. Sequential use of execution-policy/store seams. |
| S1.09 `T-909552` | `daemon/{extension-ui,extension-bindings}.ts`, `extensions.ts`; portable `packages/ext-*` execution/presenter splits (ordinary shared-launch env lookups remain valid). Host UI files are transferred explicitly after S1.05; no concurrent or duplicate host env/auth implementation. Four batches: generic+ask-user; prewalk/fusion/MCP/browser/llama; operational panels; remaining built-ins. Own extension manifests/lockfile serially after S1.02. |
| S1.10 `T-CBCAAF` | `apps/tui/src/session-client/{client,reducer,transport}.ts` and focused tests. May run alongside S1.05/06 after S1.02/03. No terminal rendering or daemon files. |
| S1.11 `T-1332B0` | `apps/tui/src/tui-client/**`; interactive part of `application.ts`; client command/keybinding dispatch and replacement of InteractiveMode patches. S1.09 owns extension entrypoints; S1.11 consumes them. |
| S1.12 `T-758644` | `tui-client/presenters/**`, host onboarding flows (`dependency-onboarding.ts`, `project-trust-prompt.ts`), existing local presentation files after S1.09/11 handoff. Consumes, not rewrites, execution halves. |
| S1.13 `T-3EB8F6` | `acp/**`, headless part of `application.ts`; `resume.ts`, `session-picker.ts`, `prompt-history.ts` direct-store removal and `savings-command.ts` CLI read-only proof or daemon routing. Hard prerequisite S1.11: do not edit `application.ts` until it finishes. ACP translations remain here; execution policy stays in daemon. |
| S1.14 `T-6202F4` | `daemon/{management,entrypoint}.ts`, `cli.ts`, `cli-main.ts`, `index.ts`, `restart-command.ts`, `process-restart.ts`, client host-status UI; explicit isolated-target CLI wiring and pinned management identity. May consume S1.03 files only after handoff. |
| S1.15 `T-BDD9C6` | `apps/tui/test/story1/**`, shared test-only fake model/process/fault helpers; integrated `scripts/test-packed-bin.mjs` acceptance extensions after S1.02 handoff. Fixes outside tests go back to their owner. |
| S1.16 `T-843239` | User/release docs, final manifests/versions/notices/lockfile, release workflow and packed audit. Final sole writer after all integration tasks. No publish authorization. |

**Shared-file rule:** additions to `agent-core/src/index.ts`, application exports,
manifests and lockfile are requested as a small explicit patch from their current
owner. Do not run two installs, builds that delete the same `dist`, or packed
verification jobs concurrently. Generated files are not a backchannel for edits.
The orchestrator owns integration decisions, not application code. Public app
contracts use Agent Core re-exported types, not new direct pinned-Pi imports.

### Per-task review evidence

Before the first mutation, use `.artifacts/story1/reviews/S1.xx/` (gitignored):

1. Record base HEAD, task ID, source paths and `git status --short`. Record hashes
   of pre-existing user files. Never copy secrets, configs, auth or live stores.
2. Copy each existing file **at task start**, preserving its relative path under
   `before/`; record newly created paths in `new-files.txt`. This is essential
   when HEAD does not contain earlier tasks' uncommitted work.
3. At candidate readiness copy only owned paths under `after/`. Generate a
   before/after unified patch, using an empty before file for additions. Include
   removals explicitly. HEAD-wide `git diff` is insufficient for later tasks.
4. Store command, exit code and bounded test logs plus reviewer findings/fixes.
   Record in task notes exact changed files, public decisions, blockers and the
   review-artifact path. Refresh after/patch after review fixes.
5. Leave the task `in_progress` for the parent's Opus review. Only complete after
   parent-confirmed approval and successful required verification.

`scripts/pack.mjs` currently deletes the entire `.artifacts` directory. Before
`pnpm verify`/`pack:all`, mirror review evidence to a private disposable directory
outside `.artifacts`, write test output there, and restore the evidence afterward.
Do not let a release check silently erase the snapshots needed for review.

Original user changes in `packages/ext-subagents/{README.md,src/index.ts,test/index.test.ts}`
are not task output. S1.01 records their hashes and source patch as local review
evidence; later owners compare against that baseline and preserve the delta.
No commit, push, publish, reset, linked database activity or live-daemon operation
is authorized by this plan.

## Safe cutover and rollback

Keep the work on a nonshipping integration branch/worktree until S1.15 passes
and S1.16 approves release readiness. Intermediate modules can coexist in source,
but never advertise partial single-writer behavior or ship a mixed entrypoint.

1. Before testing cutover, stop **only disposable fixture** owners. For a real
   release, the operator explicitly stops all old Felan/TUI/ACP/headless/memory
   workers and verifies their descendants; do not kill arbitrary processes by
   name. Detection is best-effort for old binaries, not a fence.
2. Back up every resolved store root, including custom `sessionDir`, `agentDir`
   session storage, subagents, memory and relevant configuration, with private
   permissions. Record version, paths, hashes and completion. Copying active
   files is not a consistent backup; explicitly stop detached jobs too before
   claiming a quiescent full backup. Never put credentials in review artifacts.
3. New daemon acquires account singleton and all canonical root locks **before**
   opening a writer. Pre-daemon files are not listed or resumable. Explicit
   import creates a fresh managed ID without changing the source.
4. Cut over TUI, ACP and headless together. Tests must prove client imports cannot
   construct/open SessionManager or start local runtime execution. `acp login`
   alone may update `auth.json` using its existing lock; it is not a session writer.
   Standalone `felan savings` currently constructs a HostAgentRuntime; S1.13 must
   prove its complete query path cannot write/start work or route it through the
   daemon. Its command name is not evidence of read-only behavior.
5. On failed upgrade, stop/drain the new daemon and explicitly settle any retained
   detached jobs before replacing their store roots. Verify owned work is stopped.
   Keep a private copy of the post-upgrade stores; export readable history using
   the new binary if needed. **Never point an old binary at live/new-format data.**
   Restore the complete pre-upgrade backup into separate roots and start the old
   binary there after ownership checks. New post-upgrade work is not merged
   automatically; exports are history, not resumable execution authority.
6. A force-stop/restart may interrupt effects. Preserve winning answers and
   indeterminate request outcomes. Verify foreground/child/PTY termination and
   persist independent detached-job identities before releasing ownership.
   Replacement reconciles those existing jobs without relaunching them; unknown
   launches or ambiguous process identity block affected writes until resolved.
   Never silently rerun a shell, prompt or continuation.

Downgrade/import are acceptance fixtures, not actions to perform on this
developer's stores. Network filesystems without verified lock/identity semantics
are unsupported for canonical writable roots; fail closed rather than fall back
to mtime leases. Old noncooperating binaries can still ignore locks: disclose this
residual risk and require operator quiescence, not a false exactly-one-writer claim.
