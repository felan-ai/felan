# Felan vs OpenAI Codex

> Last verified: 2026-08-21. Felan baseline `0.12.10` at
> `abd4ee34ab2bc2289802af4d2a317b56239f44c5`; Codex source snapshot
> `aea26afaee177d3fe40721ef261a29f89879d505` was reviewed on 2026-08-17.

## Short answer

Felan is a good fit when you want a host-owned, model-portable terminal agent
with a shared dependency-aware task graph, same-session Prewalk handoff,
bounded evidence-oriented web tools, and explicit source-controlled built-ins.

Codex is a good fit when you want OpenAI's structured command surface, native
Plan mode, OS-enforced command sandboxing and approvals, and Codex-specific
interactive or programmatic workflows. The choice is primarily about the host
and safety model around the coding agent, not only the model that is selected.

## At a glance

| Dimension | Felan | OpenAI Codex |
| --- | --- | --- |
| Primary surface | Local interactive TUI with a `felan` binary; an initial message still enters the TUI | Codex CLI and its documented local agent surfaces |
| Task state | Persistent root-session objects with prerequisites, acceptance criteria, ownership, claims, ready/blocked views, and verified results | `update_plan` checklist with ordered progress state; the reviewed source does not describe Felan's dependency graph and ownership invariants |
| Planning | Prewalk hands one useful session from a planner to a target model after a focused mutation; it is not an approval gate | Explicit non-mutating Plan mode and plan transition |
| Coding tools | Ordinary Pi tools, with a GPT-specific `exec_command`/`write_stdin`/`apply_patch` mode when the exact provider/model policy matches | Structured shell, patch, PTY, and approval/sandbox controls designed for Codex models |
| Local safety | Host filesystem/process permissions; no general OS sandbox or action-approval system | OS-enforced sandbox and configurable approval/network policies |
| Web research | Search, claim checking with exact passages, bounded fetching, paging, and default SSRF protection | Remote-backed web search with documented cached/live modes |
| Extensibility and MCP | Source-controlled built-ins; remote HTTP OAuth MCP through one bounded gateway | Hooks and broader MCP configuration are part of the documented Codex surface |
| Hosting and providers | Portable Agent Core and extension contracts; host supplies authenticated model scope | Codex-oriented OpenAI product and model surface |

For the full cross-agent rows, see [planning](feature-matrix.md#planning-tasks-and-agent-coordination),
[tools](feature-matrix.md#local-tools-execution-and-code-intelligence), and
[MCP/safety](feature-matrix.md#extensibility-mcp-safety-and-models).

## How the workflows differ

### Felan tracks executable dependencies, not just progress

Felan's task graph is shared by the root and nested children. A dependent task
cannot become ready until its prerequisites are complete, and a worker claims a
ready task atomically. Acceptance criteria, notes, stale-claim recovery, and a
required completion result make the graph useful for handoff and verification.

Codex's `update_plan` is a progress checklist. It is intentionally separate
from Codex Plan mode and does not provide the same documented dependency,
ownership, or ready-frontier model. That makes Codex's plan lighter; Felan's
graph is more useful when several workers must coordinate a bounded execution
order.

### Planning has a different safety meaning

Codex Plan mode is an edit-restricted planning workflow with an explicit
transition to execution. Felan Prewalk is model routing inside one session: the
planner explores, creates a prompted task graph, makes a qualifying mutation,
and the next request goes to the target tier or exact model with useful history.
There is no approval checkpoint before that first edit.

Choose Codex when “show me a plan before changing files” is the central
requirement. Choose Prewalk when preserving grounded exploration while handing
implementation to another model is more valuable.

### The coding tools are model-adapted in Felan

Felan keeps ordinary Pi tools for most models and activates the compact Codex
surface only for GPT-family models on the exact `openai` or `openai-codex`
providers. Switching models restores the ordinary tools. This keeps the
portable feature extensions available across providers, while still giving
eligible GPT models the tool shape they expect.

Codex's structured shell and patch behavior is its native center of gravity.
Its reviewed shell contract also exposes PTY, polling, and sandbox-related
controls. Felan's local runtime can use a PTY in its Codex adapter, but the
overall host remains unsandboxed.

### Web access optimizes for evidence versus remote search

Felan's `source_check` can retain exact passages from bounded fetched sources,
and `get_search_content` pages retained results without placing every byte in
the active transcript. DNS and redirects are checked for SSRF safety, and
external text is explicitly untrusted.

Codex's web search is a strong remote search surface with cached/live modes and
its own network and approval guidance. It is not documented in the reviewed
source as the same local evidence-artifact and exact-passage workflow.

## Choose Felan when...

- a root session and asynchronous children need one dependency-aware execution
  graph;
- you want to route planning and implementation between authenticated models
  without losing the useful session history;
- provider portability and host-supplied model scope matter more than a
  single-vendor workflow;
- web research must include bounded claim checking, retained passages, and
  default private-network protections; or
- you want built-ins selected by the local application rather than arbitrary
  project extensions being loaded automatically.

## Choose Codex when...

- OS-enforced command isolation and approval modes are a requirement;
- you want a native Codex tool surface and Plan mode rather than Felan's
  ordinary/Pi-plus-adapter composition;
- Codex's own non-interactive, thread, or programmatic workflows fit your host;
  or
- Codex's supported model and integration surface is already the right boundary
  for your organization.

## Migration and interoperability

Both tools can use repository instructions, but they do not have identical
discovery or precedence rules. Felan reads one cwd-level `AGENTS.md` or
`CLAUDE.md`, then progressively discovers nested files after structured reads.
Codex's reviewed guidance supports its own `AGENTS.md` hierarchy and override
rules.

Felan does not import Codex's ambient extensions, project settings, prompts,
skills, or MCP configuration. A project `.mcp.json` is accepted only through
Felan's supported remote HTTP OAuth shape; stdio, bearer, socket, and custom
header entries are skipped. Treat this as selective interoperability, not a
drop-in migration.

## Trust and data boundaries

Felan's local host runs with current-user permissions and has no general OS
sandbox. Its narrower boundaries apply to resource discovery, web SSRF, browser
sessions/screenshots, document conversion, remote MCP, and credential storage.
Codex's sandbox and approval controls provide a different, stronger default for
untrusted command execution. See [Felan runtime and security](../concepts/runtime-and-security.md)
and Codex's [approval and security documentation](https://developers.openai.com/codex/agent-approvals-security).

## Questions Codex users ask

### Can I use the same model provider?

Felan asks the host to provide authenticated models and supports model-specific
tool behavior. The exact provider/account flow depends on the model runtime;
Felan is not a replacement for Codex's account or subscription service.

### Does Felan have Codex-style Plan mode?

No. Felan has Prewalk, which is a same-session planner-to-implementation model
handoff rather than a read-only plan approval workflow.

### Is Felan safer for arbitrary shell commands?

No. The local Felan host is not a sandbox. Use an isolated host when shell
commands or the repository are not trusted.

## Sources and methodology

This page uses the dated [feature matrix](feature-matrix.md) and
[comparison methodology](methodology.md). Primary Codex references include the
[Plan prompt](https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/collaboration-mode-templates/templates/plan.md),
[subagents](https://developers.openai.com/codex/concepts/subagents),
[AGENTS.md](https://developers.openai.com/codex/guides/agents-md),
[shell schema](https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/core/src/tools/handlers/shell_spec.rs),
[web search](https://developers.openai.com/codex/web-search),
[hooks](https://developers.openai.com/codex/hooks), and
[MCP](https://developers.openai.com/codex/mcp).

## Try Felan

```sh
npx @felan-ai/felan
```

Start with [Getting started](../getting-started.md), then review the
[runtime boundary](../concepts/runtime-and-security.md).
