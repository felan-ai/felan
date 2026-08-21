# Felan vs Claude Code

> Last verified: 2026-08-21. Felan baseline `0.12.10` at
> `abd4ee34ab2bc2289802af4d2a317b56239f44c5`; Claude Code documentation was
> last reviewed on 2026-08-17 without a pinned CLI version.

## Short answer

Felan is a good fit when you want a model-portable local host, a structured
dependency-aware task graph, same-session Prewalk model routing, bounded
evidence-oriented web research, and source-controlled built-ins with explicit
host ownership.

Claude Code is a good fit when you want Anthropic's mature permission modes,
automatic memory and project conventions, worktree-capable subagents, hooks,
plugins, broad MCP workflows, Chrome integration, or non-interactive/SDK
surfaces. This is a different tradeoff between Felan's portable, narrower host
policy and Claude Code's broader first-party ecosystem.

## At a glance

| Dimension | Felan | Claude Code |
| --- | --- | --- |
| Primary surface | Local interactive TUI and `felan` binary | Terminal CLI plus documented SDK, background, team, and browser integrations |
| Providers | Host-supplied authenticated model scope; Felan adapts tools for eligible GPT models and keeps other models on ordinary tools | Anthropic-centered model and account surface, with provider/API deployment options documented by Anthropic |
| Task state | Shared graph with prerequisites, claims, acceptance criteria, ownership, ready/blocked views, and verified results | Task tools with IDs, dependencies, owners, and metadata when available; availability is model/version dependent |
| Planning | Prewalk routes the same session after a focused mutation; no approval gate | Plan permission mode and explicit plan transition; additional plan/review workflows |
| Memory and context | One cwd instruction file plus progressive nested context and local Markdown memory outside the repository | `CLAUDE.md` hierarchy, memory features, path-scoped rules, and checkpointing workflows |
| Subagents | Asynchronous bounded children, live navigator, steering, continuation, cancellation; text results | Built-in/custom subagents, background work, worktree isolation options, and agent teams/messaging features |
| Web/browser | Bounded HTTP evidence tools; reviewed browser CLI integration with explicit attachment guidance | Web tools plus separate Claude-in-Chrome integration; capabilities depend on enabled integrations |
| Local safety and extensions | Host permissions, no general sandbox, source-controlled built-ins, OAuth-only remote MCP | Permission modes, optional sandboxing, hooks/plugins/skills, broader MCP and integration surface |

See the detailed [planning matrix](feature-matrix.md#planning-tasks-and-agent-coordination),
[context matrix](feature-matrix.md#context-memory-and-sessions), and
[safety matrix](feature-matrix.md#extensibility-mcp-safety-and-models).

## How the workflows differ

### Felan's graph is an execution contract

Felan's task graph combines hard prerequisites, ready/blocked queries, atomic
worker claims, acceptance criteria, handoff notes, and verified results. The
root and nested children see the same graph, which makes bounded multi-agent
work explicit.

Claude Code's current task tools are more capable than a simple todo list: the
reviewed documentation describes IDs, dependencies, owners, and metadata.
Their availability is model/version dependent, and the public contract does
not document Felan's exact claim, stale-recovery, priority, acceptance-result,
or ready-frontier invariants. Claude Code teams add peer coordination and
worktree options that Felan does not currently provide.

### Prewalk is not Claude Code Plan mode

Claude Code's Plan permission mode is intended to keep work read-only or
edit-restricted until the user approves a plan transition. Felan Prewalk is a
same-session model handoff: the planner explores, creates a prompted graph,
makes a focused mutation, and the next request runs on a configured target
model with useful history. There is no separate plan artifact or approval gate.

Choose Claude Code when approval before edits is central. Choose Felan when
preserving the planner's grounded trajectory while switching model strength is
central.

### Memory ownership is different

Felan's local memory is an inspectable Markdown wiki outside the repository.
Settled root-session evidence is staged, redacted, bounded, validated, and
published by a host-owned coordinator. Existing memory remains readable without
credentials, and child sessions do not publish evidence.

Claude Code's `CLAUDE.md`, memory, rules, and checkpointing workflows are a
first-party ecosystem for users who want the incumbent's conventions and
session controls. Felan can read a cwd-level `CLAUDE.md`, but it does not import
the rest of Claude Code's ambient commands, agents, rules, or MCP configuration.

### Felan's web surface is evidence-oriented; Claude's is broader elsewhere

Felan provides `source_check`, bounded exact passages, retained-result paging,
PDF/GitHub fetching, explicit untrusted-content envelopes, and default SSRF
protections. It is intentionally an HTTP/content pipeline rather than a
cookie-authenticated browser.

Claude Code has its own web tools and a separate Claude-in-Chrome integration
for browser-backed workflows. That is a better fit when logged-in browser
state, browser interaction, or Anthropic's integrated experience matters. It is
not the same security or ownership model as Felan's explicit browser CLI and
host confirmation boundary.

### Extensibility is deliberately narrower in Felan

Claude Code supports hooks, custom agents, skills, MCP, teams, and other
first-party or project-configured extensions. Felan packages portable feature
contracts and the local application loads only source-controlled built-ins.
That reduces ambient extension drift and preserves a clear host boundary, but
it means Claude Code configurations are not drop-in Felan plugins.

## Choose Felan when...

- provider and model portability are core requirements;
- your workflow benefits from a hard dependency graph shared with child agents;
- you want bounded web evidence and a default private-network boundary;
- host-owned credential, storage, and extension policy matters more than a broad
  ambient plugin ecosystem; or
- you want Pi-compatible foundations without carrying a Pi source fork.

## Choose Claude Code when...

- you want Anthropic's first-party permission, plan, memory, and checkpoint
  workflows;
- worktree-isolated subagents, agent teams, or peer messaging are important;
- hooks, skills, custom agents, plugins, or broad MCP transports are already
  part of your repositories; or
- Claude-in-Chrome and Claude Code's own SDK/background surfaces fit your host.

## Migration and interoperability

Felan reads one cwd-level `AGENTS.md` or `CLAUDE.md`, then progressively loads
nested files after structured reads. It does not load `.claude/agents`,
`.claude/commands`, `.claude/rules`, Claude Code hooks, ambient skills, or
Claude Code MCP configuration automatically.

Existing repository instructions can therefore be shared selectively, but
commands, agents, permissions, memory, and MCP entries need an explicit port.
Felan's project `.mcp.json` supports the remote HTTP OAuth subset and skips
stdio, sockets, bearer credentials, custom headers, direct tool injection, and
MCP Apps.

## Trust and data boundaries

Felan's local process is not a sandbox. It runs with current-user filesystem and
process permissions and applies narrower controls to web requests, remote MCP,
browser sessions, document conversion, memory, dependencies, and ambient
resources. Claude Code provides permission modes and optional sandboxing that
may be a better fit for untrusted command execution. Compare the exact host
configuration rather than treating either product name as a complete security
boundary.

See [Felan runtime and security](../concepts/runtime-and-security.md) and
Claude Code's [permission modes](https://code.claude.com/docs/en/permission-modes),
[subagents](https://code.claude.com/docs/en/sub-agents),
[memory](https://code.claude.com/docs/en/memory),
[MCP](https://code.claude.com/docs/en/mcp), and
[Chrome](https://code.claude.com/docs/en/chrome) documentation.

## Questions Claude Code users ask

### Will my `.claude/` setup work unchanged?

No. Felan can read a cwd-level `CLAUDE.md`, but its local resource policy does
not import the full `.claude` extension/configuration ecosystem. Translate
agents, commands, hooks, rules, and MCP entries deliberately.

### Can I use Felan only with Anthropic models?

Felan's host supplies the authenticated model scope and its extensions are
model-portable. If Anthropic is the only model family you want, Felan still
offers its task graph, Prewalk, web evidence, and host policy; Claude Code may
remain the better fit for Anthropic-specific integrations.

### Does Felan have automatic memory?

Yes, locally. It is an account-free Markdown wiki with host-owned idle batching
and validation. It is not Claude Code's memory/rules implementation and does not
silently synchronize with a team memory service.

## Sources and methodology

This page uses the dated [feature matrix](feature-matrix.md) and
[comparison methodology](methodology.md). Primary Claude Code references include
[tools](https://code.claude.com/docs/en/tools-reference),
[task tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking),
[permission modes](https://code.claude.com/docs/en/permission-modes),
[memory](https://code.claude.com/docs/en/memory),
[subagents](https://code.claude.com/docs/en/sub-agents),
[agent teams](https://code.claude.com/docs/en/agent-teams),
[commands](https://code.claude.com/docs/en/commands),
[checkpointing](https://code.claude.com/docs/en/checkpointing),
[hooks](https://code.claude.com/docs/en/hooks),
[MCP](https://code.claude.com/docs/en/mcp), and
[Chrome](https://code.claude.com/docs/en/chrome).

## Try Felan

```sh
npx @felan-ai/felan
```

Start with [Getting started](../getting-started.md) and the
[local security guide](../concepts/runtime-and-security.md).
