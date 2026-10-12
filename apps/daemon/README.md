# Felan session daemon

`@felan-ai/daemon` owns the session server, registry, admission, persistence,
local profile, runtime resources and host execution. It has no dependency on
the `@felan-ai/felan` client application. The client installs its exact daemon
version as part of the same local installation.

The installed entrypoint runs the owned service; importing the package does not
start a daemon. Clients launch and manage it through the exact installed package.
The daemon persists after client detach and owns graceful drain, explicit force,
recovery, and replacement coordination.

## Exports and versions

- `.` exports `DAEMON_VERSION` and the profile contract.
- `./daemon-profile` exports `DAEMON_PROFILE_API_VERSION = 1` and profile types.
  The local implementation is not part of that profile export.
- `./internal/*` is implementation-oriented support for the exact Felan client.
  Exported subpaths remain public APIs: assess them under SemVer and coordinate
  changes with exact client releases.

`@felan-ai/daemon` and `@felan-ai/session-protocol` have intended initial 0.1.0
releases. They are not published by this change. Before CI may publish either,
a maintainer must complete the manual 0.0.0 bootstrap and npm trusted-publisher
setup in [the release procedure](../../docs/releasing.md).

## Presentation and verification boundary

Execution and durable interaction state run in the daemon; TUI, ACP, headless,
and themes remain client-owned. The pinned `@earendil-works/pi-coding-agent` SDK
transitively depends on `@earendil-works/pi-tui`, so this package is not claimed
to be terminal-free.

The explicit `zod` dependency preserves the Pi SDK's optional-peer resolution.
Without it, pnpm can select a second Pi dependency context and split shared SDK
identities. Do not run daemon tests against a developer account. Use the approved
disposable, mount-free verification runner; changing HOME alone does not isolate
an OS user.
