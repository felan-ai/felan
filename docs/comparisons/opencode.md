# Felan vs OpenCode

> Last verified: 2026-08-21. Felan baseline `0.12.10` at
> `abd4ee34ab2bc2289802af4d2a317b56239f44c5`; OpenCode `1.18.10` at commit
> `14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5` was reviewed on 2026-08-17.

## Short answer

Felan is a good fit when you want a portable Agent Core, explicit source-
controlled built-ins, a shared dependency-aware task graph, same-session
Prewalk routing, bounded evidence-oriented web access, and a deliberately
narrow local resource policy.

OpenCode is a good fit when you want a broad local harness with a configurable
TUI, plan/build modes, todo and task agents, structured file/search tools, LSP,
permission patterns, plugins, MCP, and additional server or SDK surfaces. The
central tradeoff is explicit host policy versus a wider configurable surface.

## At a glance

| Dimension | Felan | OpenCode |
| --- | --- | --- |
| Primary surface | Local interactive TUI and `felan` binary | Configurable local TUI with documented session/server/SDK surfaces |
| Task state | Persistent shared graph with prerequisites, claims, acceptance criteria, and verified results | Session todo list plus a separate task/subagent tool; no equivalent graph in the reviewed snapshot |
| Planning | Prewalk hands the same session from planner to target after a focused mutation | Plan agent and plan/build transition with edit restrictions depending on mode/policy |
| Files and search | Pi `read`/`write`/`edit`/`bash`, plus feature extensions and RTK compaction | First-class `read`, `glob`, `grep`, shell, and model-dependent edit/write or patch tools |
| Code intelligence | No built-in LSP or debugger in Felan's reviewed local surface | LSP is available but reviewed defaults/configuration can leave it disabled; no DAP core feature |
| Safety | Host permissions; explicit web/MCP/browser/document boundaries; no general sandbox | Tool and pattern-level permission rules; reviewed defaults are more permissive than Codex's sandbox |
| Extensibility and MCP | Source-controlled built-ins; OAuth-only remote MCP gateway | Plugins and broader MCP server configuration |
| Context and sessions | cwd instructions plus progressive nested context, local memory, and Pi session state | Global/ancestor instructions, nested context, session navigation, undo/redo and broader configuration |

See the full [planning matrix](feature-matrix.md#planning-tasks-and-agent-coordination),
[tool matrix](feature-matrix.md#local-tools-execution-and-code-intelligence),
and [extensibility matrix](feature-matrix.md#extensibility-mcp-safety-and-models).

## How the workflows differ

### Felan's task graph is one execution state model

Felan combines task identity, prerequisites, ready/blocked queries, atomic
claims, ownership, acceptance criteria, handoff notes, and verified results in
one graph shared with nested children. `/tasks` shows the graph directly.

OpenCode's reviewed design separates the session todo list from the task tool
that launches child sessions. That separation is useful when a lightweight
checklist and independent workers are enough, but it does not express Felan's
single shared prerequisite frontier.

### Planning and implementation have different boundaries

OpenCode's Plan agent creates a plan artifact and transitions to Build through
its plan workflow. Felan Prewalk does not create a read-only plan gate: it keeps
one useful conversation, performs a focused mutation, then switches the next
request to a configured target model. Use OpenCode when approval before edits is
the desired control; use Prewalk when model handoff without losing context is
the desired control.

### OpenCode exposes more structured local code tools

OpenCode's reviewed local surface includes `read`, `glob`, `grep`, shell, LSP
integration, and configurable permissions. Felan's ordinary models use Pi's
small coding surface and commonly search through shell commands; RTK can
compact command-aware results, but Felan does not currently provide OpenCode's
first-class LSP surface.

This is a meaningful OpenCode advantage for repositories where diagnostics,
symbol navigation, or structured file search are central. Felan's strength is
keeping those host/tool choices portable across its extension contracts rather
than assuming a broad local integration set.

### The resource and extension policies are intentionally different

OpenCode's plugin and configuration model is designed to be extended from the
user/project environment. Felan's local TUI filters ambient Pi extensions,
packages, prompts, themes, project settings, and package resources and loads
only its source-controlled built-ins plus explicit Felan skills/agents.

Felan therefore has a smaller implicit attack and compatibility surface, but
OpenCode is more convenient when a team already relies on its plugins, custom
tools, or MCP server configuration.

## Choose Felan when...

- workers need one dependency-aware graph with explicit claims and results;
- you want same-session planner-to-implementer routing rather than a separate
  plan artifact;
- web work needs provider-backed discovery, bounded matching text/PDF passages,
  and default SSRF protections;
- you want the local app to load a reviewed built-in set instead of ambient
  project extensions; or
- portable extensions must run behind a host-provided runtime and credential
  boundary.

## Choose OpenCode when...

- first-class `glob`, `grep`, and LSP are more valuable than Felan's narrower
  coding surface;
- you want a plan/build workflow with configurable permissions;
- plugins, custom tools, and broader MCP server transports are part of the
  product you are building; or
- OpenCode's server, SDK, or TUI surfaces are a better fit than Felan's local
  interactive binary.

## Migration and interoperability

Both systems can work with repository instruction files, but their discovery
and configuration rules differ. Felan reads one cwd-level `AGENTS.md` or
`CLAUDE.md` and then discovers nested files after structured reads. OpenCode's
reviewed loader combines global/ancestor instructions and nested `AGENTS.md`,
`CLAUDE.md`, or legacy `CONTEXT.md` behavior.

Felan does not import OpenCode plugins, project settings, MCP configuration,
permissions, or tool definitions. A migration should explicitly translate
configuration and test each workflow; shared repository instructions are not a
promise of identical behavior.

## Trust and data boundaries

Felan's local host is unsandboxed but has explicit boundaries for web SSRF,
remote OAuth MCP, browser sessions, document conversion, external dependencies,
and ambient resources. OpenCode provides configurable per-tool and pattern
permissions, but the reviewed defaults and integrations have a different
security posture. Read [Felan runtime and security](../concepts/runtime-and-security.md)
and OpenCode's [permissions](https://opencode.ai/docs/permissions) before
choosing a host for untrusted work.

## Questions OpenCode users ask

### Can Felan load my OpenCode plugins?

No. The local host intentionally filters ambient extensions and packages. Port
the behavior into a Felan extension or use the portable package contracts.

### Does Felan replace OpenCode's LSP?

No. Felan's reviewed local surface does not ship a built-in LSP tool. Use
OpenCode or another integration when language-server navigation and diagnostics
are a hard requirement.

### Can I use the same MCP configuration?

Only selectively. Felan supports explicit remote HTTP OAuth servers through its
gateway and skips stdio, sockets, bearer credentials, custom headers, and MCP
Apps. See [MCP and browser workflows](../user-guide/web-mcp-and-browser.md).

## Sources and methodology

This page uses the dated [feature matrix](feature-matrix.md) and
[comparison methodology](methodology.md). Primary OpenCode references include
the reviewed [agent and Plan source](https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/agent/agent.ts),
[task tool](https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/task.ts),
[progressive instructions](https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/session/instruction.ts),
[LSP](https://opencode.ai/docs/lsp),
[permissions](https://opencode.ai/docs/permissions),
[plugins](https://opencode.ai/docs/plugins),
[MCP](https://opencode.ai/docs/mcp-servers), and
[TUI](https://opencode.ai/docs/tui).

## Try Felan

```sh
npx @felan-ai/felan
```

Start with [Getting started](../getting-started.md) and the
[architecture guide](../concepts/architecture.md).
