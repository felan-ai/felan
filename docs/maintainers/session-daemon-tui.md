# Daemon-backed terminal client

The interactive CLI path uses `SessionClient` and client-owned terminal
components. It does not construct `LocalFelanRuntime`, open session transcripts,
or give a synthetic `AgentSession` to `InteractiveMode`. Runtime effects remain
behind admitted daemon operations.

## Session and input behavior

- `--continue`, `--resume` and `--session` select daemon-owned sessions. `--session`
  attaches an exact ID even when the session is an unlisted draft; a prefix is
  matched against the listing. A missing ID starts a new session with a warning.
  `--resume` and `/resume` open on the current folder's newest sessions and add
  the other folders as their pages load. The terminal title is the session name,
  or the folder name when there is none. No no-session warning is shown while the
  first session is being created.
- A normal Enter submits a prompt when idle and steers an active turn. Alt+Enter
  queues a follow-up. Shift+Enter keeps a newline in the editor.
- Escape cancels the current run. Ctrl+D on an empty editor and `/exit` detach
  the client; they do not stop a run or dispose the daemon.
- `/close` closes the session without a confirmation; attaching later reopens it. `/cwd` creates a
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

Rejected or uncertain submissions retain editor input and may be resubmitted.
Connection, recovery, policy restrictions and queued work remain visible.
`/reconnect` retries bounded client recovery; it does not authorize a different
daemon instance or silently weaken policy.

### Blocked daemon recovery

`host.status` reports a daemon-wide `blocked` state separately from blocked
session attachments. `/daemon status` presents its cleanup step, short session
ID, failure message, and `/daemon restart force` hint. Ordinary operations
rejected with `host_blocked` produce a retry-cleanup notice rather than a generic
rejection; repeated rejections replace the status note instead of appending
duplicates.

For recoverable cleanup failures, `/daemon stop`, `/daemon restart`, and
`/restart` confirm “Retry daemon cleanup with force?” and warn that remaining
work will be interrupted. Confirmation sends a forced control operation;
cancellation sends none. An explicit `force` skips this recovery confirmation.
Unrecoverable failures show the manual forced-termination instruction for the
daemon PID and send no lifecycle control. A rejected operation first shows the
daemon's refusal, then one notice built from `host.status`, so repeated
rejections do not add notes. Control rejections and failures while waiting for
shutdown retain the TUI-specific recovery hint and any new failure detail.
The daemon remains the sole owner of cleanup and process lifetime.
Startup against a blocked daemon retains the initial draft and leaves the
terminal open for recovery commands without trying to create or attach a session.

ADR [0038](../decisions/0038-resume-transcripts-at-their-last-entry.md)
resumes each transcript at its last entry, so Pi-durable work is always visible and
never stale. It does not alter transcript history.

## Update cost

A running session sends updates continuously, and they share the event loop with
keyboard input, so work per update must not grow with the session's size:

- Frequent readers use `SessionClient.readAttachment`, which shares the current,
  deeply frozen attachment state. `getAttachment` copies the whole attachment and
  is only for callers that need a mutable copy.
- The screen applies controller updates once per rendered frame, before the frame
  draws, rather than once per update. Applying them must not request another render.
- The transcript compares projections by identity first: unchanged messages keep
  their projected objects, and progress from running tools updates the existing
  transcript instead of rebuilding it.

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

The terminal renders shared forms, documents, views, progress and statuses.
Optional versioned hints enhance presentation without changing data or actions;
unknown hints use the generic renderer. There is no custom interaction registry.
Streamed views read their own interaction's session, not whichever root happens
to be selected. Agent navigation uses scoped `executions.*` operations; tool
renderers live in `apps/felan`, not extension TUI entrypoints.

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

Run client and daemon tests through `scripts/test-isolated.sh`, including
`scripts/test-isolated.sh pnpm verify` for the full gate.

The pre-services S1.15 baseline completed offline, multi-client, restart, failure-injection, ACP,
and headless acceptance. The recorded aggregate is 3,941 passing assertions with
3 declared skips across 352 file executions; literal `pnpm verify` passed.
Daemon-only packaging covered 27 packages without the client, with two
foreground start/stop/ownership cycles passing.

Three user-approved historical test exceptions remain bounded known risks. Linux
arm64 has only the documented verification scope; Windows remains deferred and
untested. Publication, trusted-publisher setup, and independent review are not
claimed.
