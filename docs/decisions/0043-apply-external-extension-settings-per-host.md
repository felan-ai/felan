# ADR 0043: Apply external extension settings per host

## Status

Accepted. Amends [ADR 0013](0013-opt-in-pi-extension-directories.md) and
[ADR 0031](0031-bind-project-trust-to-the-creating-client.md).
Related: [Configuration](../user-guide/configuration.md#runtime-resources-and-session-behavior)
and [connector CR 24](../shared-session-daemon/contract-change-requests-felan.md#24-host-configured-external-extensions-for-web-created-sessions).

## Context

External extensions were restricted to interactive TUI roots even though their
directory settings belong to the host. Session creation also carried a client
source and a per-session enablement flag. That made the same host configuration
behave differently for TUI, ACP, headless and web-created sessions, and excluded
children from their root's extensions.

Folder trust remains a local decision, not a privilege granted by opening a
project for remote creation. It cannot be prompted uniformly across clients:
ACP presents host prompts only through an already-ready ACP session, so a
prompt during its first `session/new` could hang. Headless runs cancel prompts,
and web creates have no local client.

## Decision

Keep the global settings `piExtensions.user` and `piExtensions.project`, both
off by default. They configure external extensions per host and apply to every
new root session: TUI, ACP, headless/print mode, web through the remote
connector, and `session.import`. The user setting loads
`~/.pi/agent/extensions`; the project setting loads `<cwd>/.pi/extensions`
only when that folder is trusted, directly or through a parent.

Only the TUI creating a session may receive its folder-trust prompt, preserving
ADR 0031's creator affinity. With no saved trust decision, ACP, headless and web
creates skip project extensions without saving a decision; a later TUI create
can still ask. A saved trust decision applies to every creator. Denial and
dismissal never approve project code.

Local clients may supply additive explicit paths with `--extension`/`-e`;
remote creates may not. External extension paths are fixed at creation. Resume
keeps saved paths, clone/fork keep the source session's paths, and adopting an
existing unindexed transcript on attach loads no external extensions. Child
sessions, including subagents, execution children and workers, load their
root's external extension paths. A worker's tool allowlist still limits its
active tools.

Remove `interactiveExtensions` and the creation `source` (`tui | acp | headless`)
from `sessions.create`; sessions no longer record which client created them.
The `hello` client `kind` and `OriginSchema` remain unchanged, including
`{ kind: 'web', user, command }` run/queue provenance. Do not add a `web` client
kind.

`piExtensions.llamaCpp` remains a separate, root-only opt-in for the built-in
llama.cpp integration, for roots created by any client. It is unaffected by
external extension inheritance. Ambient Pi packages, settings, skills, prompts
and themes remain filtered.

## Alternatives considered

- Keep a per-session flag: rejected because it duplicates host configuration
  and lets the creating client determine which host features are available.
- Add a `web` client kind: rejected because remote work already has web
  provenance, and extension policy should not depend on a new client category.
- Prompt every client through `canPresent`: rejected because advertised prompt
  capability does not imply a ready presenter during creation. In particular,
  ACP's first `session/new` could hang waiting for its own session to be ready.

## Consequences

- Enabling these settings also runs external extension code, with the user's
  permissions, in ACP, headless, web-created and child sessions. Tool allowlists
  restrict active tools, not the permissions of loaded JavaScript.
- Unattended creation never waits for folder trust or silently trusts a new
  folder. Opening a remote project does not grant extension trust or permission
  to supply explicit paths.
- Saved paths make resume and derived sessions independent of later discovery
  settings; changing those settings affects newly created roots, not saved
  external extension paths.
- Clients must stop sending the removed creation fields. The daemon implements
  this policy ahead of the platform's decision on CR 24, at the user's request;
  CR 24 asks the platform to amend the accepted CR 9/CR 10 extension wording.
