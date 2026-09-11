# ADR 0006: Authorize existing-browser control separately

> Status: Accepted
> Date: 2026-09-11
> Deciders: Felan maintainers
> Related: [Browser extension](../../packages/ext-browser/README.md), [Runtime and security](../concepts/runtime-and-security.md)

## Context

Felan can launch an isolated browser safely, but reusing authentication from a
person's running Chrome requires a Chrome DevTools Protocol connection with
browser-level authority. Prompt guidance currently asks the model to obtain
confirmation before passing direct attachment flags, but the extension does not
enforce that boundary. Failed attempts also fall back to logged-out browsers,
which is surprising and does not satisfy the requested workflow.

Chrome 144 and later provide an explicit remote-debugging permission flow.
`agent-browser` 0.37.1 can bind a named session to one target with strict
`--pin-tab` behavior, but its `--auto-connect` path still performs a throwaway
WebSocket verification with a short timeout (upstream issue #1365; proposed
fix PR #1508 is not merged). These controls reduce accidental cross-tab access,
but they do not narrow the underlying CDP grant. In particular,
`agent-browser` does not permit its network-domain allowlist with an existing
CDP browser, so origin checks around Felan commands are defense in depth rather
than a browser or network sandbox.

## Decision

Add a separate `browser_authorize` control-plane tool and retain `browser` as
the ordinary data-plane tool. Authorization is available only through an
interactive host binding. The local TUI owns bounded, filesystem-only discovery
of the current user's stable Google Chrome `DevToolsActivePort` file. It reads
only fixed profile paths, validates a loopback WebSocket path, and never probes
the endpoint during discovery. The host obtains explicit user consent and makes
one direct-CDP Chrome attachment attempt. If the endpoint is missing, the host
opens its remote-debugging settings and rediscoveries only after the user
requests it. Successful authorization
opens a fresh Felan-owned tab, binds it strictly to the current Felan browser
session, and then lets normal `browser` calls reuse that connection.

Keep authorization in memory and bind it to the current root session, browser
scope, target, and approved origin. Revoke it on explicit request, browser
closure, target loss, scope violation, or session shutdown. Resumed or replaced
processes require fresh authorization. Do not persist cookies, browser state,
CDP endpoints, or grants, and do not silently substitute an isolated browser
when authorization fails.

The Browser extension owns the authorization state machine, CLI invocation,
model-facing contract, and enforcement. The local TUI owns consent and Chrome
setup presentation through a host adapter. Agent Core remains adapter-neutral.
Direct model-selected `connect`, `--cdp`, and `--auto-connect` paths are removed;
noninteractive, ACP, cloud, and subagent contexts fail closed unless their host
deliberately supplies an equivalent interactive authorization implementation.

## Alternatives Considered

- Keep prompt-only confirmation around direct attachment flags: rejected
  because it is unenforced, error-prone, and lets the model mix authorization
  with ordinary browsing.
- Add authorization as another `browser` operation: rejected because it mixes
  a high-trust host interaction with routine untrusted page operations and
  makes policy enforcement less visible.
- Require a TUI command before every attached workflow: rejected because the
  agent cannot request and await the prerequisite as part of the task flow.
- Build a Chrome extension and native-messaging relay: deferred because it can
  provide stronger tab-oriented consent but adds a separate installation,
  protocol, and security boundary that is unnecessary for the first supported
  flow.

## Consequences

- Existing-browser access requires Felan's scoped consent and Chrome's
  remote-debugging dialog. Felan never probes by opening a second connection.
- Missing, stale, malformed, inaccessible, symlinked, or unsafe endpoint files
  fail closed without exposing paths or endpoint material. Standard Chrome
  profile roots are supported on macOS, Linux, and Windows; custom profile
  locations are not guessed.
- Ordinary isolated browser automation remains available without authorization.
- A fresh pinned tab limits accidental interference, but a compromised local
  process or CLI with the CDP endpoint could still control the wider browser.
- Felan can reject explicit out-of-origin navigation, unrelated-tab commands,
  and browser-wide state export, but it cannot claim network isolation for an
  attached browser.
- Host implementations must keep connection material out of model output,
  logs, persisted session state, and status text, and must make cancellation,
  revocation, and shutdown idempotent.
