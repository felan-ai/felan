# Felan session daemon

`@felan-ai/daemon` owns the session server, admission, registry, canonical
persistence and execution lifetime. It has no dependency on the Felan client
or extension implementations. `@felan-ai/felan` supplies local providers,
default configuration and clients, and installs the exact daemon version.

Importing this package does not start a daemon. A managing package launches the
installed entrypoint with trusted configuration. Provider modules resolve from
that installation, never from the working directory or project content.

## Contracts and configuration

- `.` exports `DAEMON_VERSION` and the configured `SESSION_RUNTIME_SERVICE`.
- `./session-runtime` describes session composition and host operations for
  configuration, preferences, setup and root preparation. Providers supply
  these operations and credential storage; the daemon retains admission and
  shutdown ownership.
- `./provider` describes trusted provider definitions, restricted execution
  ports, process adapters and shared storage/locking helpers.
- `./client` exposes authenticated local transport, target resolution and
  managed daemon launch. `./daemon-bootstrap` supports managing entrypoints.
- The only internal subpath, `./internal/daemon/ui-vocabulary`, supports the
  runtime UI translator. Registry, stores and persistence implementations are
  not exported.

Local settings parsing, keychain credentials, model defaults, HTTP bootstrap,
system prompt loading, folder trust and authentication workers belong to
`@felan-ai/felan` providers, not the daemon package.

The old `./daemon-profile` export is removed. Daemon 0.2.0 and protocol 0.2.0
are coordinated incompatible-minor releases with Agent Core 0.13.0.
They are not published by local verification. New npm packages still require
the manual 0.0.0 bootstrap and trusted-publisher setup in the
[release procedure](../../docs/releasing.md).

`host.json` selects providers, extensions and policy. Precedence is an explicit
absolute path, the agent-directory file, then a packaged default supplied by
the manager. The generic daemon has no implicit local provider configuration.
Provider changes require restart. Session configuration and storage identities
are checked on restore; changed or missing identities require explicit reload.
Control state uses version 1. Invalid or unsupported data fails closed and is
preserved for recovery; there is no automatic migration, reset or replay.

Stdio transports and their persistent readers are session infrastructure, not
active work. Their consumers report in-flight requests through the runtime
lifetime service. Idle transports do not prevent reload or eviction; the daemon
still terminates them and joins their readers before releasing the session.
Shell jobs and interactive terminals continue to block eviction while running.

## Presentation and verification

Clients render the shared UI vocabulary. Optional renderer hints do not grant
authority. Capabilities and trusted transport facts determine eligibility;
client-kind labels do not. Host setup applies policy before local-console
approval, and strict ACP execution policy remains independent of presentation.

The pinned Pi SDK transitively includes `pi-tui`; this package is not claimed
to be terminal-free. Run tests through `scripts/test-isolated.sh`, which gives
each run a fresh HOME, agent directory and TMPDIR.
