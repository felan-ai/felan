# ADR 0013: Opt in to Pi extension directories with Felan settings and project trust

> Status: Accepted
> Date: 2026-09-17
> Deciders: Felan maintainers
> Related: [Runtime and security](../concepts/runtime-and-security.md), [Local CLI](../user-guide/local-cli.md)

## Context

The interactive TUI can load explicit local Pi extensions with `--extension`.
Ambient Pi discovery stays off, including `~/.pi/agent/extensions` and
`<cwd>/.pi/extensions`. Users want those two standard Pi locations as optional
sources without restoring Pi packages, prompts, themes, skills, or project
settings.

Felan's agent directory is `$FELAN_AGENT_DIR`, not `~/.pi/agent`. Turning on
Pi ambient discovery would therefore look in `~/.felan/extensions`, skip Pi's
real home directory, and couple extension loading to Pi's full project-resource
surface. The TUI currently stubs project trust as always trusted because that
surface is filtered.

## Decision

The local TUI owns an opt-in in Felan global settings with two independent
sources: user-home Pi extensions and project-local Pi extensions. Both default
off. Agent Core keeps receiving an explicit path list and does not grow
discovery policy.

User-home, when enabled, loads `~/.pi/agent/extensions` for interactive root
sessions. Those files are already the user's global Pi extensions, so they do
not require a per-folder prompt.

Project-local, when enabled, loads `<cwd>/.pi/extensions` only after a Pi-style
trust decision for that folder. A new directory with project extensions asks
once; the answer is remembered and parent-folder decisions apply as in Pi.
Trust is stored under `$FELAN_AGENT_DIR`, not shared with `~/.pi/agent/trust.json`.
Trusting a folder authorizes those project extension files only. It does not
load Pi project settings, packages, skills, prompts, or themes.

Headless, ACP, and subagent sessions still do not load these paths. `--extension`
remains additive.

## Alternatives Considered

- Keep `--extension` only: rejected because users need persistence and a
  new-folder confirmation, not a repeated path list.
- Global project boolean without trust: rejected because every cloned
  repository could execute `.pi/extensions` without consent.
- Enable Pi ambient discovery and Pi's trust store: rejected because Felan's
  agent directory is not Pi's, and Pi trust unlocks the rest of the project
  resource surface.
- Per-project path allowlist in settings: rejected in favor of Pi's
  ask-and-remember folder trust, which matches the desired new-folder prompt.

## Consequences

- Pi users can reuse home and project extension directories without giving
  Felan ambient package or settings discovery.
- New folders can execute project extension code only after an explicit trust
  answer; declining keeps the current filter.
- Felan and Pi trust files stay separate, so a decision in one app does not
  silently change the other.
- `/cwd` must re-resolve project extensions against the new folder's trust
  state. Resource-boundary documentation must describe the opt-in and the
  prompt.
