# ADR 0044: Bridge Claude Code through a managed Agent SDK

> Status: Accepted
> Date: 2026-10-21
> Deciders: Felan maintainers
> Related: [Claude Code guide](../user-guide/claude-code.md), [runtime dependencies](../reference/runtime-dependencies.md#claude-code-managed-runtime), [upstream tracking](../maintainers/upstream-extensions.md#claude-code-bridge)

## Context

Users want Claude plan authentication while retaining Felan's agent loop,
tools, approvals, extensions, and canonical session history. The API-key
`anthropic` provider remains useful but does not provide that transport.
MIT-licensed pi-claude-bridge already implements the SDK query loop, MCP tool
parking, prompt projection, and Claude Code history mirroring.

Anthropic's Agent SDK is proprietary (`SEE LICENSE IN README.md`) and ships an
approximately 225 MB per-platform binary. Linux downloads both glibc and musl
variants, roughly 450 MB in total. Bundling it into Felan would add that
distribution, installation, and licensing burden for users who never select
Claude Code. Its MCP implementation must resolve from the same managed install
as the SDK.

Claude Code mods run hooks under the Agent SDK, but do not replace its query
and tool-parking loop. Organization policy can block sideloaded mods. A mod is
not needed to disable native tools or auto-compaction, or to receive usage
events. Anthropic's [October 7, 2026 support update][plan-usage] allows Agent SDK
and third-party app usage against subscription limits; Felan cannot decide
the billing classification of an individual request.

## Decision

Vendor pi-claude-bridge 0.9.3 at
`874fa7c2678456336f23b64e784e2057e608d83e` in `@felan-ai/ext-claude-code`,
preserving MIT attribution and a diffable `src/bridge/` baseline. Register
provider `claude-code` through Agent Core, with Felan-owned settings, per-session
lifecycle handling, and isolated tool-free requests. Remove upstream AskClaude;
Felan subagents already own delegation.

Install the pinned Agent SDK and its peers only through an explicitly approved
managed installation in agent storage. Never add the SDK or managed Anthropic
and MCP packages to Felan package dependency fields. Load them through a
generated ESM entry in that installation; activation only inspects and loads
an existing runtime.

Use a committed, reviewed npm lockfile with integrity hashes for the full
dependency closure and `npm ci --ignore-scripts`. Verify the platform-specific
Claude Code binary package matching the host's libc on Linux. Completed installs
are verified in staging before being moved into place. Replacement removes an
incomplete target before the move and is not atomic. A valid installation is
never removed or replaced; reinstalling it is a no-op.

Felan keeps the loop, tools, approvals, and canonical history. Claude Code runs
with `tools: []`; an in-process MCP bridge parks tool calls until Felan returns
results. Disable Claude Code auto-compaction through the child environment and
consume usage from SDK messages. Ship no companion mod. Keep this a documented
host-only I/O exception: the SDK spawns Claude Code and `cc-session-io` accesses
its local session files.

Keep one Claude Code process per live Felan session between prompts: end each
turn on its successful result and write the next prompt to the running process
while its configuration and history still match. Otherwise close its input, wait
for it to exit, and resume in a fresh process. Stop the process when the session
shuts down, which includes daemon idle eviction, or leaves Claude Code models.

## Alternatives considered

- **Bundle the Agent SDK as a dependency:** simpler module resolution, but
  forces proprietary runtime distribution and a large platform download into
  every Felan install. Explicit managed installation preserves user choice.
- **Claude Code mod-only integration:** hooks can influence Claude Code, but
  do not replace query orchestration and tool parking. Policy can prohibit
  sideloading, and a mod adds no required capability here.
- **API-key `anthropic` provider only:** the simplest existing path, retained
  unchanged, but does not meet the Claude plan-login requirement.
- **Load upstream through `piExtensions`:** useful for experiments, but bypasses
  the owned settings/install boundary and retains upstream lifecycle, prompt,
  and dependency assumptions instead of Felan's multi-session adaptations.

## Consequences

- Felan remains the agent, with no second approval or delegation system and no
  startup SDK download. Missing SDKs leave only this provider unavailable.
- npm registry and proxy configuration still applies, including registry
  mirrors through `replace-registry-host`, but lockfile integrity is enforced.
- Rebuilds after compaction, navigation, aborts, or model switches resend
  history and can miss the prompt cache. Prompt changes can lag until rebuild.
- Later prompts skip Claude Code startup and session reload, but each resident
  session holds an idle process of roughly 200–260 MB until shutdown or
  eviction. A process that exits before answering a written prompt is replaced
  and the prompt rerun.
- Vendoring incurs upstream sync and regression-test maintenance, especially
  around history, tool pairing, and prompt projection.
- Zero catalog prices are not a free-usage or savings claim. Quotas, Extra
  Usage, plan eligibility, and billing classification remain Anthropic-owned.
- Host-only process and filesystem access limits runtime portability; the
  supported managed install is macOS/Linux, not Windows or non-host runtimes.
  Claude Code settings, hooks, session files, and logs remain privacy concerns.

[plan-usage]: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
