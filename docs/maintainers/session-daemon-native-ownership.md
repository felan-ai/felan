# Local daemon ownership primitives

This is an **internal, nonshipping S1.03 candidate**, not a completed daemon or
a claim of Windows support. The first implementation targets Unix/macOS/Linux.
The user explicitly deferred Windows; its unsupported, fail-closed behavior
and documented follow-up are not current completion blockers. No CLI, registry,
profile, session server or live store is cut over. The application version
remains for S1.16 to decide.

## Native choice and packaging

The application pins **Koffi 3.3.2**, MIT, from
<https://github.com/Koromix/koffi>. Its installed `package.json`, `index.d.ts`,
`README.md`, `LICENSE.txt` and native loader were inspected. npm lists 3.3.2 as
released on 2026-09-27; this avoids selecting the same-day 3.3.3 release.
Koffi is a maintained Node-API v8 FFI with optional, version-matched platform
packages, including `@koromix/koffi-{darwin,linux,win32}-{x64,arm64}`. Upstream
support is not proof that Felan's platform adapter was tested.

`native-ownership.ts` uses public libc functions, not private Node handles:

- `flock(LOCK_EX | LOCK_NB)` for retained file-descriptor lifetime locks.
- `socket`, `bind`, `listen`, `accept`, `connect`, `fcntl`, `getsockopt` and
  Darwin `getpeereid` / Linux `SO_PEERCRED` for native authenticated AF_UNIX
  transport. Accepted, authenticated descriptors enter Node through the public
  `new Socket({fd, readable:true, writable:true})` constructor.
- `FD_CLOEXEC` and `O_NONBLOCK` on native socket descriptors. Node filesystem
  descriptors are close-on-exec; a real exec-descendant/crash test exercises
  that they do not prolong the owner's locks.
- Darwin `lchmod` / Linux `fchmodat(AT_SYMLINK_NOFOLLOW)` to protect the socket
  without following a substituted symlink.

The install script is
`node ./cnoke.cjs -P . -D src/koffi --prebuild --release` and is explicitly
allowed in `pnpm-workspace.yaml`. It selects prebuilds; upstream's source-build
path requires its documented CMake/compiler toolchain. Do not assume a compiler
is available or suppress a missing native module with a lease-lock fallback.
Keep optional dependencies when installing/bundling. There is no Felan native
binary to copy into `dist`: Koffi and its prebuild remain production dependencies
in the packed application's dependency closure. Root/application NOTICE and
the license inventory include the pinned dependency.

Actual local evidence is Darwin arm64, Node 22.20.0, pnpm 9.15.5. The dependency
installed and the real native adapter executed. A separate clean temporary
installation verifies the prebuild without running install scripts. Full packed
application verification must be serialized by the orchestrator; this task does
not independently run `pnpm verify` or `pack:all`.

## Platform gates

| Platform | State |
| --- | --- |
| Darwin arm64 | Real multiprocess ownership, native peer checks, socket protection, stale cleanup, fencing and detached-readiness tests run locally. |
| Darwin x64 | Adapter present, not executed here. CI/release gate. |
| Linux glibc arm64 | Candidate build/type-check and all 22 focused tests passed in a disposable Debian Bookworm container, Node 22.20.0/pnpm 9.15.5/glibc 2.36. Four additional production-ledger tests ran only in a separate disposable account/container without host mounts. A real UID 0 server / UID 65534 client probe confirmed kernel `EACCES` denial. This is focused container evidence, not a full Linux application-suite run. |
| Linux glibc x64 | Not executed here. CI/release gate, including native peer checks, locking, no-follow chmod, inherited descriptors, file identities and socket limits. |
| Linux musl and other architectures | Fail closed if the verified libc/ABI is unavailable. No claim of support from Koffi's broader matrix. |
| Windows | **Deferred by explicit user decision; unsupported and fail-closed** with `platform_blocked` before ownership or target creation. Follow-up requires native token/SID identity, lifetime handle locks, pipe DACL, client/server token checks, reparse-safe storage, a Windows transport/launch-channel adapter and actual Windows tests. It is not a current completion blocker. Koffi's Windows prebuild does not implement these. |

No TCP path exists. POSIX paths reject NUL and lengths above 103 bytes on Darwin
or 107 on Linux. The Linux run exercised the actual 107-byte bind boundary,
native peer checks and locks. Its separate cross-UID probe ran only inside the
disposable container; it does not prove Darwin cross-user behavior. Linux
bind-mount aliases and additional architectures remain CI gates. Windows
execution remains deferred, not implicitly supported. No host account creation
or user configuration changes were made.

### Linux evidence and remaining gates

Docker Desktop's local Linux arm64 daemon was available; no missing-runtime
exception is needed. Only copied S1.03 sources/tests and the protocol dependency
were supplied to the container. Dependency installation happened during image
build; tests ran without networking, with a read-only root filesystem and a
disposable `/tmp` tmpfs. The shared verification lock covered the complete
build/test block. Test-owned containers and image tags were removed; no user
containers were started, stopped or modified.

The first Linux run is retained as a failed run, despite all 19 assertions
passing. The unhandled resets are emitted by the client sockets when the test
deliberately removes/replaces the owned endpoint. The user then authorized a
narrow test-only correction: wait for socket closure and assert that any error
occurred during the requested teardown and has code `ECONNRESET`. Unexpected
errors still fail the test; no runtime error is suppressed. The revised checked-in
candidate passed without unhandled errors, as well as the separate cross-UID
probe. Subsequent review regressions cover listener setup and accepted-socket
ownership-loss windows; all 22 focused tests pass on macOS and Linux arm64.
Full application Linux testing, Linux x64 and bind-mount alias coverage remain
release/CI work.

The failed first run, diagnostic-only diff and final candidate result are
retained separately under `.artifacts/story1/reviews/S1.03/`. Final Linux
container inputs, source hashes and dependency lock are in `linux/final-r4/`;
the review-fix logs are `logs/r4-focused-macos-linux.log` and
`logs/r4-full-macos.log`. All runs held the shared verification lock. Tests ran
with networking disabled in the container; the current result does not depend
on the diagnostic-only copy.

## Ownership and target contract

`resolveDaemonTarget` is read-only. Callers must supply an explicit production
target (agent directory plus startup custom roots) or an isolated target
(fixture directory plus a non-production namespace ID). `HOME`,
`FELAN_AGENT_DIR`, `USER` and `TMPDIR` do not determine account identity or the
account coordinator. `os.userInfo()` supplies the OS account; set-ID execution
is rejected. The coordinator is the fixed owner-private
`/private/tmp/felan-<uid>-daemon-v1` on Darwin or `/tmp/felan-<uid>-daemon-v1`
on Linux, under the canonical system temporary directory. It is shared by all
namespaces, not placed in a selectable agent directory.

Production always uses the same `production.lock`, regardless of selected
roots. Isolated namespace locks are hashed names in the same coordinator.
Isolated stores, agent directory and runtime must stay within their canonical
fixture; they cannot contain/use the real account's `.felan`, the coordinator,
or an active/previously registered production root. The global ledger protects
custom production roots too. Initial isolated acquisition requires an empty
private directory and writes a private marker pinned to its namespace and
directory inode. Reuse requires that marker; a nonempty unregistered directory
cannot be converted into a fixture even if the temporary account ledger was
lost across reboot. To seed fixture configuration, first acquire/release the
empty fixture, then seed it and reuse the same target. Host tests use only new
explicit fixture targets and never acquire the host production singleton.
Production-ledger regressions run solely in an explicitly guarded disposable
container account, without host mounts. Isolated claims use this same account
coordination path, remove only their own claim on settled release, and leave
lock inodes intact; they do not reset or rewrite unrelated claims.

`acquireDaemonOwnership` holds the separate short-lived coordination lock while
checking claims and taking lifetime namespace/store locks. The bounded private
ledger is atomic-renamed and fsynced. It compares canonical paths and directory
inode ancestry to reject exact aliases, parent/child overlaps and inode aliases
across namespaces. All declared roots are acquired before returning authority.
The agent directory itself is locked, conservatively covering its session,
task, memory, subagent and shared storage descendants. Custom roots outside it
must be declared too. The returned root set is minimal and immutable for the
instance; additional roots require an explicit restart, not an unlocked open.

Locks are never unlinked to unlock. Stale isolated claims are pruned only after
their original retained lock inode can be locked. Production root records are
retained to prevent later isolated reuse. Repeated unchanged production claims
are replaced by the newest instance, deduplicated by canonical root/inode set;
their ancestor history is merged. Distinct former paths or inode generations
remain protected. Compaction precedes the record-capacity check, so duplicate
history from an earlier instance cannot permanently consume all slots.
Missing/replaced recorded namespace
lock inodes or a corrupt ledger block recovery rather than implying death.
PID values and readiness files are not ownership evidence. Unknown/network
filesystems fail closed; the allowlist is APFS/HFS on Darwin and common local
Linux filesystem magic values, which still require platform CI validation.

## Fencing and integration

- `DaemonOwnership.assertCurrent()` checks retained locks and path identities.
  Use it synchronously before every admission and after any async boundary
  before dispatch/write. `assertOwnsPath(path)` additionally canonicalizes and
  returns a path within the startup root set; **use the returned path**.
- The owner checks identities every 25 ms as an additional idle guard. Deleting,
  replacing, relinking or changing permissions of a watched lock/root/endpoint
  permanently fences that instance. Recreating the old pathname does not
  un-fence it. `onLost` closes listeners/connections immediately when detected.
  The interval is not a promise of instantaneous revocation between arbitrary
  syscalls, and is not a replacement for synchronous admission checks.
- Locks remain held after fencing until callers settle their writers and call
  idempotent `release()`. Do not release while an owned operation or descendant
  can still write. These primitives do not claim to revoke an already-running
  shell, unfenced child or old binary. Legacy operator quiescence and S1.06/14
  descendant settlement remain necessary.
- `listenLocalIpc(owner, callback)` only gives authenticated same-account
  sockets to the session server. It caps live connections and closes them on
  ownership loss. Cleanup owns the native listener throughout path-watch and
  loss-subscription setup. Accepted sockets are tracked before the ownership
  recheck or callback transfer, so a failure there closes both peer and listener
  without removing a replacement endpoint. `connectLocalIpc` checks native server credentials, private
  endpoint type/mode and stable path identity. A live endpoint is never removed;
  a stale socket is removed only under ownership after native `ECONNREFUSED`
  and an unchanged socket inode. Non-sockets and symlinks are not cleaned up.
- `protocolTarget` maps the internal launch target to the actual public
  `@felan-ai/session-protocol` target shape. `identityFor` and
  `assertTargetIdentity` use its full namespace/instance/agent/root tuple.
  `serveReadiness`/`probeDaemon` implement only bounded, read-only authenticated
  control status using the package's real parsers. They are not a session server
  or a version-mismatch management implementation.
- S1.10 can use `connectLocalIpc`, `protocolTarget` and tuple verification. S1.04
  can use `assertOwnsPath`, `assertCurrent`, `onLost` and the retained owner.
  Neither needs a profile dependency. Profile/session replacement is not wired
  here. New sessions must not silently introduce roots outside the owner.

## Detached startup and diagnostics

`spawnDetachedDaemon` resolves the current Node executable and supplied local
entrypoint, preserves the launch environment and cwd, detaches, and uses a
private inherited FD 3 channel—not an environment token or a readiness file.
The child acquires ownership and initializes its services before calling
`publishDaemonReadiness`. The launcher validates the full tuple, probes the
live authenticated endpoint, then acknowledges. The child must settle/release
on an absent acknowledgement or startup error. The launcher never kills a PID
from a receipt or guesses whether an unrelated process is stale.

Client/launcher exit does not dispose a ready daemon. Closing an unacknowledged
launch channel only cancels a **cooperative** child; an arbitrary/uncooperative
entrypoint is not claimed to have stopped. S1.14 must use the cooperative
entrypoint and lifecycle contract. No provider/account/update requests run in
these helpers; readiness must stay gated on the later application's real ready
state. There is no per-session environment provision/patch mechanism.

Raw detached stdout/stderr go to the null device. The explicit
`BoundedDaemonLogs` sink keeps separate owner-only bounded diagnostic files;
callers must pass safe diagnostics, never environment dumps, credentials or raw
provider errors. The launcher reports fixed sanitized errors rather than
echoing child output. No control credentials are added to inherited environment.

## Verification

Run after building the TUI (the process fixtures import its emitted modules).
The entire shared build/type-check/test block must hold an exclusive Python
`fcntl.flock` on
`/tmp/felan-story1-verification-01a1249a-2227-7793-828b-19ffb702d139.lock`.
Use a cleared test environment and disposable HOME/TMPDIR/agent directory, as
recorded in the serialized verification harness. Do not run these commands
outside that coordination lock:

```sh
pnpm --filter @felan-ai/felan build
pnpm --filter @felan-ai/felan type-check
pnpm --filter @felan-ai/felan exec vitest run test/daemon-ownership.test.ts test/daemon-ipc.test.ts
pnpm --filter @felan-ai/felan test
pnpm check:licenses
```

The focused suite includes five concurrent starters, a SIGSTOP-paused owner,
SIGKILL/restart with an exec descendant, custom/alias/overlap refusal,
store/endpoint replacement and deletion, safe socket cleanup, full tuple
mismatch, forged/failed/timed-out readiness, bounded diagnostics and a real
launcher-exit/reattach test. Child termination and fixture cleanup are limited to
test-owned processes/paths. Review snapshots and exact logs live in
`.artifacts/story1/reviews/S1.03`; mirror them outside `.artifacts` before the
orchestrator runs packing, which deletes that directory.

`test/fixtures/daemon-production-ownership.mjs` must run only in a disposable
Linux UID-0 container with its explicit opt-in, a private `/tmp` tmpfs and no host
work/config mounts. It refuses other environments before acquiring ownership.
Its four regressions cover 1,030 unchanged acquisition/release cycles, recovery
from 1,024 duplicate historical rows, former-root exclusion and distinct inode
generation exclusion. These are real kernel ownership cycles, not a claim of
1,030 separately spawned daemon processes. Never run this fixture against the
host coordinator, even with a temporary HOME.
