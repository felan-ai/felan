# ADR 0002: Share the Bash process surface across models

> Status: Accepted
> Date: 2026-09-09
> Deciders: Felan maintainers

## Context

GPT-specific `exec_command`/`write_stdin` duplicated process ownership already
provided by Felan's runtime and created a short-wait session loop for commands
that normally finish synchronously. OpenAI's documented familiarity guidance
provides direct support for `apply_patch`, but not for the exact Codex process
schemas. Felan also needs one process lifecycle for foreground commands,
detached work, and optional interactive PTYs.

## Decision

Use the provider-neutral Bash surface for every selected model. Keep
`apply_patch` as the GPT-specific editing replacement, while ordinary `read`
remains active and MarkItDown continues to intercept that reader directly.

Foreground Bash waits in the tool for a bounded, configurable window (120
seconds by default). On expiry it promotes the already-started process without
restarting it. Explicit background commands use durable detached records. PTY
jobs use live root-session handles, support exact input/control bytes, and are
not reattached from stale PIDs after shutdown.

## Alternatives Considered

- Keep Codex process tools: rejected because no direct evidence establishes a
  benefit over the shared runtime and the duplicate lifecycle increases context
  and maintenance cost.
- Use only synchronous Bash: rejected because independent long-running work and
  interactive commands need explicit background/PT​​Y control.
- Build a restart-durable PTY supervisor: deferred because it adds a daemon and
  IPC boundary without a current product requirement.

## Consequences

- Models see one consistent process contract and fewer provider-specific modes.
- Existing detached jobs remain durable; interactive PTYs are intentionally
  session-scoped.
- Foreground cancellation terminates the process tree, while cancellation of a
  background wait does not terminate the job.
- Internal coordinators must serialize PTY operations and keep output bounded.
