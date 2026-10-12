# Daemon-backed terminal client

The interactive CLI path uses `SessionClient` and client-owned terminal
components. It does not construct `LocalFelanRuntime`, open session transcripts,
or give a synthetic `AgentSession` to `InteractiveMode`. Runtime effects remain
behind admitted daemon operations.

## Session and input behavior

- `--continue`, `--resume` and `--session` select daemon-owned sessions. A missing
  ID starts a new session with a warning only when inventory is complete.
- A normal Enter submits a prompt when idle and steers an active turn. Alt+Enter
  queues a follow-up. Shift+Enter keeps a newline in the editor.
- Escape cancels the current run. Ctrl+D on an empty editor and `/exit` detach
  the client; they do not stop a run or dispose the daemon.
- `/close` is a distinct, confirmed session-close operation. `/cwd` creates a
  new session in the chosen directory after the current run settles.
- `/model`, `/thinking`, `/compact`, `/rename`, `/reload`, `/queue`, `/fork` and
  `/tree` use the server's catalog and operations. Targeted queue editing remains
  unavailable; queue display and steer/follow-up enqueue are supported.
- Fork selection covers stored user entries across branches and forks before
  the selected entry. It can restore full known text to the editor but never
  automatically submits it. Numeric positions remain zero-based.
- Ctrl+L selects a model, Ctrl+P/Alt+P cycle models, Shift+Tab cycles thinking,
  Ctrl+O expands tools and Ctrl+T toggles thinking. The key map uses public TUI
  primitives and loads daemon-owned preferences and keybinding overrides.

Rejected or uncertain submissions retain editor input. An immediate identical
resubmission of uncertain work is blocked rather than assigned a fresh request
ID. Connection, recovery, policy restrictions and queued work remain visible.
`/reconnect` retries bounded client recovery; it does not authorize a different
daemon instance or silently weaken policy.

ADR [0035](../decisions/0035-reconcile-pi-tip-before-restoring-selection.md)
fixes the observed Pi-tip crash by hiding a Pi user entry at the current tip while
preserving the older branch selection. It does not alter transcript history.

## Configuration and resources

CLI extension settings use the existing validated wire fields. Creation stores
session-scoped overrides; attaching with configuration changes uses an admitted
quiescent reload. These values do not modify global settings and survive idle
eviction and recovery. See [ADR 0028](../decisions/0028-retain-session-scoped-launch-options.md).

Executable extension paths are fixed at session creation. Repeating `-e` while
attaching is rejected explicitly; omit it to retain the existing paths, or
create a new session for a different path set. This is an intentional difference
from the former single-process launch path, where there were no other attached
clients whose executable code could be replaced.

`--daemon-runtime` is an explicit test/CI-only isolated directory selector. It
is never taken from ambient environment. Normal launch resolves the exact
installed daemon package and retains its canonical target/identity checks.

## Built-in presentation and local setup

The terminal registers versioned presenters for questions, Prewalk and Fusion
reviews, Tasks, Processes, Context, Memory, Prompt History, Agent Navigator,
Powerline, and local browser/report opening. Streamed views read their own
interaction's session, not whichever root happens to be selected. Unknown
presenters fail visibly; unknown tools retain the generic renderer.

`/settings` changes visual preferences. The terminal keeps drafts
while dialogs are active and applies accepted display/keybinding changes
locally. Themes are owned and loaded by the terminal, not the daemon. Different
clients observing the same session may use different palettes. Theme fields
are not part of the daemon preference protocol. See
[ADR 0034](../decisions/0034-keep-themes-local-to-each-client.md).

Project-extension discovery happens in the daemon before creating an
interactive root. Trust prompts target only the creating TUI. Denial or
dismissal never approves project code, and disconnect does not transfer that
decision to another terminal. See [ADR 0031](../decisions/0031-bind-project-trust-to-the-creating-client.md).

`/dependencies` and attachment-time onboarding send explicit choices to the
daemon. Installers never run in the model or terminal process. `/login` also
uses daemon setup jobs; credentials travel only through the ephemeral setup
answer operation, not durable interaction answers or session transcripts.
Setup dialogs hold focus ahead of newly arriving model questions. Browser and
report opening require an explicit local action. See
[ADR 0032](../decisions/0032-isolate-ephemeral-host-authentication.md).

A missing provider does not close the terminal or submit retained input.
The user can sign in and then create a session explicitly. Daemon management
uses the service described in [session-daemon-service.md](session-daemon-service.md).

## Acceptance boundaries

S1.15 completed Story 1 offline, multi-client, restart, failure-injection, ACP,
and headless acceptance. The recorded aggregate is 3,941 passing assertions with
3 declared skips across 352 file executions; literal `pnpm verify` passed.
Daemon-only packaging covered 27 packages without the client, with two
foreground start/stop/ownership cycles passing.

Three user-approved historical test exceptions remain bounded known risks. Linux
arm64 has only the documented verification scope; Windows remains deferred and
untested. Publication, trusted-publisher setup, and independent review are not
claimed.
