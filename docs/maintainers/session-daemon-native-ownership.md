# Local daemon ownership primitives

`apps/daemon/src/daemon` owns account identity, canonical store locks, local
IPC and detached startup. The native backends support macOS, glibc Linux and
Windows on x64 and arm64. Other platforms, unsupported architectures and
unavailable native backends fail closed with `platform_blocked`. There is no
heartbeat-lease or TCP fallback. Windows does not require POSIX emulation for
these operations.

## Native choice and packaging

`@felan-ai/daemon` pins Koffi 3.3.2, MIT, from
<https://github.com/Koromix/koffi>. Koffi supplies Node-API bindings and optional,
version-matched platform packages, including Darwin, Linux and Windows x64/arm64
prebuilds. Keep optional dependencies when installing or bundling. Koffi remains
a production dependency; there is no separate Felan native binary to copy into
`dist`. A source build requires Koffi's documented CMake/compiler toolchain.
Do not replace a missing native backend with a lease lock.

On POSIX, `native-ownership.ts` calls libc through Koffi for `flock`, Unix socket
creation, `fcntl`, peer credentials and no-follow socket chmod. Darwin uses
`getpeereid`; Linux uses `SO_PEERCRED` and requires glibc. Native sockets are
nonblocking and close-on-exec. Node accepts connections through `net.Server`;
the adapter reads accepted sockets' native descriptors to check peer UIDs.

On Windows, `native-windows.ts` lazily loads `kernel32.dll` and `advapi32.dll`.
It reads the process token's user SID, checks filesystem security descriptors
and protects new private directories. Node owns named-pipe I/O.
[ADR 0048](../decisions/0048-authenticate-windows-daemon-ipc-with-a-private-secret.md)
records why pipe authentication uses a private secret instead of native token
checks.

## Account identity and paths

`resolveDaemonTarget` is read-only. Callers supply either a production target
with an agent directory and explicit store-root array, or an isolated target
with a fixture directory and non-production namespace ID. `principal` is the
POSIX UID as a string or the Windows token SID. Windows retains `uid: -1` for
compatibility; it does not use that value for authorization. POSIX refuses
set-ID execution.

`os.userInfo().homedir` identifies the OS account profile. `HOME`, `USER`,
`USERPROFILE`, `LOCALAPPDATA`, `FELAN_AGENT_DIR` and `TMPDIR` do not select the
account coordinator. Windows constructs its coordinator path from that profile,
not from a redirected known-folder lookup or the `LOCALAPPDATA` environment
variable. It normally corresponds to `%LOCALAPPDATA%\felan-daemon-v1`.
Windows canonicalization uses `realpathSync.native`, which expands short names
such as `RUNNER~1`.

| Path | Location or name |
| --- | --- |
| Darwin account coordinator | `/private/tmp/felan-<uid>-daemon-v1` under the canonical system temporary directory |
| Linux account coordinator | `/tmp/felan-<uid>-daemon-v1` under the canonical system temporary directory |
| Windows account coordinator | `<OS account profile>\AppData\Local\felan-daemon-v1` |
| Production runtime | `<account coordinator>/production` |
| Isolated runtime | `<fixture directory>/runtime` |
| Coordination and claims | `claims.lock` and `claims.json` in the account coordinator |
| Namespace lifetime lock | `production.lock` or `isolated-<SHA-256 of namespace ID>.lock` in the account coordinator |
| Store lifetime lock | `.felan-store.lock` in each locked store root |
| POSIX endpoint | `ipc.sock` in the runtime directory |
| Windows endpoint description | `ipc-endpoint.json` in the runtime directory |
| Bounded diagnostic files | `stdout.log` and `stderr.log` in the runtime directory |

Production always uses the same account singleton, regardless of selected
agent directory or roots. Isolated targets cannot contain or use the real
account's `.felan` or coordinator. Their agent directory, runtime and stores
must stay inside the canonical fixture. Isolated runtime directories cannot
redirect through symlinks; canonical root checks reject overlaps and aliases
held by another live daemon.

## Private paths and configuration

POSIX private paths require the real UID and owner-only modes. Regular files
must have one link. On Windows, private paths must be non-reparse directories
or single-link regular files. Their owner and applicable allow ACEs may name
only the account SID, SYSTEM or Administrators. A null DACL or unsupported
allow ACE fails closed with `unsafe_path`. Inherit-only ACEs do not grant access
to the object being checked.

New private Windows directories receive a protected DACL with inheritable full
control for those three principals. Existing unsafe directories are rejected,
not silently repaired. Ancestor identities are pinned. Windows additionally
checks the immediate parent for write grants to other accounts. Store-root
directories need not be owner-only; this does not waive private runtime or
managed-file checks.

`host.json` has a different trust rule because it selects executable providers.
It must be a regular file without write grants outside the account, SYSTEM,
Administrators and TrustedInstaller. Other accounts may have read access.
Windows checks the DACL rather than POSIX mode bits. Non-regular files and
disallowed write grants produce `unsafe_host_config`; native security-descriptor
read failures and unsupported ACEs propagate `unsafe_path`. Configuration
precedence remains an explicit absolute path, agent-directory `host.json`, then
the manager's packaged default. The generic daemon supplies no implicit default.

## Lifetime locks and fencing

`acquireDaemonOwnership` holds the short-lived `claims.lock` while checking the
ledger and taking namespace/store lifetime locks. Contenders retry coordination
every 10 ms for up to five seconds, then receive `ownership_busy`. The ledger
compares canonical paths and device/inode ancestry to reject overlapping stores.
An unreadable ledger is rebuilt; a claim is live only while its recorded lock
identity still matches and another process holds that lock.

POSIX uses retained `flock` descriptors. Windows opens lock files with libuv's
`UV_FS_O_EXLOCK`, share mode zero. Another open, including a plain read, fails
with `EBUSY`; `tryLockFile` treats that as contention. Never read a held lock
file to discover its owner. Closing the handle or terminating its process
releases ownership. Locks are never unlinked to unlock. A live namespace owner
causes `owner_running`; an overlapping store causes `root_conflict`.

The agent directory itself is locked. `ownRoot` acquires custom session
stores on first use and records them in `agentDir/daemon-store-roots.json`.
Recorded roots remain addressable after restart and are locked again when used.

`assertCurrent()` checks retained locks and pinned path identities synchronously;
a 25 ms interval also checks idle owners. Replacement or removal permanently
fences the instance with `ownership_lost`. Recreating a pathname does not restore
authority. Permission changes alone do not trigger this identity fence. POSIX
refreshes lock timestamps hourly against temporary-directory reapers; Windows
skips that refresh because its coordinator lives under the account profile.

Use `assertCurrent()` before admission and after async boundaries before writes.
`assertOwnsPath()` returns the canonical owned path; use that return value.
On loss, listeners and connections close. Locks remain held until callers settle
owned writers and descendants and call idempotent `release()`. Fencing does not
revoke arbitrary shells, legacy binaries or privileged processes.

## Local IPC

POSIX uses an owner-only Unix socket and verifies kernel peer UIDs on both ends.
Socket paths reject NUL and exceed neither 103 bytes on Darwin nor 107 on Linux.
Only an unchanged stale socket with native `ECONNREFUSED` is removed under
ownership. Live endpoints cause `endpoint_live`; unsafe endpoints are not removed.

Windows generates `\\.\pipe\felan-daemon-<32 lowercase hex characters>` and a
fresh 32-byte secret per launch. Binding retries `EADDRINUSE` with a new random
name, for at most four attempts. After binding, the daemon publishes version 1,
the pipe name and a base64 secret in `ipc-endpoint.json` through an exclusively
created private temporary file, file fsync and replacement. The endpoint file
is pinned and watched; cleanup removes it only while ownership and its pin
remain current.

The client validates private runtime and endpoint paths, accepts endpoint files
no larger than 4 KiB, rejects extra fields and validates the exact pipe name and
32-byte secret.
Both ends authenticate with fresh nonces and role-specific HMAC-SHA256 proofs
before the listener passes the socket to the session protocol. The normal pipe
connect and handshake each have a two-second deadline. The listener caps live
connections at 64, including pending handshakes. A failed handshake destroys
only that connection. The client rechecks its path pins after authentication.

Missing endpoint files preserve filesystem `ENOENT`. A published pipe that
returns `ENOENT` or `ECONNREFUSED` produces `stale_endpoint`; other connection
failures and authentication timeouts produce `unavailable`. Invalid endpoint
content produces `unsafe_endpoint`; invalid handshake framing produces
`invalid_handshake`; a proof mismatch produces `forbidden`.
`connectLocalIpc` makes one connection attempt; client reconnect policy is
separate.

At startup, an existing valid endpoint gets a short authenticated probe with
200 ms connect and handshake deadlines. Success causes `endpoint_live`. A
`stale_endpoint`, `unavailable`, `forbidden` or `invalid_handshake` result permits
stale-file removal only under current ownership and unchanged pins. Unsafe or
malformed endpoint files are not cleaned up automatically.

Windows pipes retain Node's default DACL. Other local accounts may open
read-only connections without authenticating, so the secret protects protocol
access rather than pipe opens. Administrators, SYSTEM and same-account code can
read it. Client opens do not impose `SECURITY_IDENTIFICATION`; mutual
authentication does not remove named-pipe impersonation or local denial-of-service
risks. Do not expose the endpoint file as model context, logs or environment.

Readiness and control operations also validate namespace, canonical agent
directory and instance ID. `assertTargetIdentity` deliberately excludes root-set
equality because the daemon can acquire more roots after a client declares its
target. A matching PID or stale readiness record is not authority.

## Detached startup and durability

`spawnDetachedDaemon` resolves the current Node executable and installed local
entrypoint, preserves cwd/environment, detaches with `windowsHide: true`, and
uses inherited FD 3 for readiness. Windows uses `overlapped` stdio for this
bidirectional channel; POSIX uses `pipe`. The launcher defaults to a ten-second
readiness deadline, validates identity, probes the authenticated endpoint and
acknowledges the child. Closing an unacknowledged channel cancels only a
cooperative child. The launcher never kills a PID from a receipt.

`runDaemonProcess` installs Windows console defaults before loading services,
providers or extensions. It defaults `windowsHide` to `true` for `spawn`,
`execFile`, `exec`, `fork` and their synchronous variants, then calls
`syncBuiltinESMExports` so ESM imports use the wrappers. Explicit options such
as `windowsHide: false` remain intact. Use `felan daemon stop` for graceful
shutdown; interrupting the foreground launcher can terminate its child
immediately on Windows.

Raw detached stdout/stderr go to the null device. `BoundedDaemonLogs` retains
separate private files, each bounded to 32 KiB by default. Callers must supply
safe diagnostics, not raw provider errors, credentials or environment dumps.
Client exit does not stop a ready daemon.

`syncDirectory` is a no-op on Windows because directory fsync fails there.
File fsync remains enabled outside the test-only skip. `replaceFile` retries
Windows `EPERM`, `EACCES` and `EBUSY` until a two-second deadline, waiting at most
20 ms per retry, then throws the last error. On POSIX, `replaceFile` renames once
and `syncDirectory` still flushes directory descriptors. Windows does not copy
POSIX modes when publishing transcript exports. See
[control persistence](session-daemon-persistence.md) for SQLite
crash and power-loss limits; file replacement is not a directory-durability
guarantee on Windows.

## Verification

Use Node.js 22.23.4 and pnpm 9.15.5. Build before process-fixture tests because
they import emitted daemon modules. Run daemon and client tests only through
`scripts/test-isolated.sh`; use explicit isolated targets, never a production
singleton under a temporary `HOME`. The script does not redirect the OS account
coordinator. Run repeated local verification one command at a time with
`--maxWorkers=2`.

The Windows CI matrix runs the daemon suite on `windows-latest` x64 and
`windows-11-arm` with Node.js 22.23.4. Daemon-suite results pass with the known
platform-assumption fixture fixes. The runner user is an elevated Administrator,
and created objects can be owned by Administrators. These results do not cover
a standard non-admin account, a separate local user's actual pipe access or
interactive console-window behavior. They do not establish a full Windows
TUI-suite pass.

Windows coverage includes token/profile resolution, DACL grants, junctions and
hard links, cross-process exclusive locks and release on process death, native
path expansion, bounded replacement retries, endpoint validation, wrong-secret
rejection, endpoint fencing, pending-handshake capacity and detached readiness.
Handshake tests also run without Windows using paired streams. Console tests
check spawn options and real child output, not visible windows on a desktop.

Windows skips POSIX-only assumptions such as `SIGSTOP`/`SIGCONT`, chmod modes,
Unix peer credentials/socket limits, replacing held lock files or their parent
directories, and hourly temporary-lock refresh. Windows-specific tests cover the
corresponding DACL, handle-lock and named-pipe behavior where applicable.

Earlier local evidence covered Darwin arm64 native ownership and detached
readiness on Node.js 22.20.0. Focused Linux glibc arm64 tests ran in disposable
Debian Bookworm containers, including a separate UID 0/UID 65534 denial probe.
That is not a full Linux application-suite result or evidence for Darwin x64,
Linux x64, bind-mount aliases or network filesystems. Koffi's broader prebuild
matrix alone does not establish Felan coverage.
