# Felan vs Oh My Pi

> Last verified: 2026-08-21. Felan baseline `0.12.10` at
> `abd4ee34ab2bc2289802af4d2a317b56239f44c5`; Oh My Pi `17.3.6` at commit
> `54e1a8c900d30e5b6185975ab02a4a923faf1717` was reviewed on 2026-08-17.

## Short answer

Felan is a good fit when you want a portable Agent Core and host-owned policy,
source-controlled built-ins, a shared dependency-aware task graph, same-session
Prewalk routing, local-first Markdown memory, and explicit SSRF/MCP/browser
boundaries.

Oh My Pi (OMP) is a good fit when you want a much broader batteries-included
native tool surface: LSP, DAP, hashline editing, worktree/typed subagents,
browser and desktop control, richer provider routing, collaboration, and a
large configurable extension ecosystem. The central tradeoff is Felan's
portable, narrower host boundary versus OMP's breadth and native integration.

## At a glance

| Dimension | Felan | Oh My Pi |
| --- | --- | --- |
| Product shape | Portable Agent Core, first-party extensions, and local TUI host | Batteries-included coding agent with a broad native engine and TUI/SDK/RPC/ACP surfaces |
| Task state | One shared dependency graph with prerequisites, claims, acceptance criteria, and verified results | Separate phased todo and task/agent systems with typed results, artifacts, and optional isolation |
| Planning | Same-session Prewalk handoff; no read-only approval artifact | Plan mode plus a separate Prewalk workflow and richer orchestration controls |
| Code intelligence | No built-in LSP/DAP in the reviewed Felan local surface | In-process LSP and native DAP tools |
| Editing and execution | Pi tools plus GPT-specific Codex tools; optional detached Bash/RTK | Native hashline/AST edits, embedded shell/coreutils, persistent eval, and richer execution tools |
| Browser and desktop | Reviewed `agent-browser` CLI integration; no general desktop tool | Browser/Electron/relay workflows plus desktop automation and media tools |
| Providers and memory | Host-supplied model scope, local Markdown memory, OAuth-owned local host | Broad provider routing, local tiny models, and configurable local/remote memory backends |
| Extension/resource policy | Source-controlled built-ins and explicit skills/agents; ambient Pi resources filtered | Broad discovery of native/foreign configuration, plugins, skills, and marketplace workflows |

See the detailed [tools matrix](feature-matrix.md#local-tools-execution-and-code-intelligence),
[agent matrix](feature-matrix.md#planning-tasks-and-agent-coordination), and
[extensibility matrix](feature-matrix.md#extensibility-mcp-safety-and-models).

## How the workflows differ

### OMP has substantially broader first-class tools

OMP's reviewed tool inventory includes LSP, DAP, AST search/edit, hashline
editing, persistent Python/JavaScript evaluation, browser/Electron control,
desktop automation, GitHub/path schemes, and collaboration. Felan's local
surface intentionally remains smaller: its core coding tools come from Pi,
with focused extensions for tasks, web evidence, browser CLI automation,
documents, MCP, background processes, and model-specific Codex tools.

Choose OMP when the editor/debugger/browser/desktop surface is the product. Do
not describe Felan as a replacement for those OMP capabilities; they are real
OMP strengths in the reviewed baseline.

### Felan's task graph is a different coordination primitive

Felan puts hard prerequisites, ready/blocked state, worker claims, acceptance
criteria, and verified results into one graph shared by the root and child
sessions. OMP's reviewed design separates phase-oriented todo state from a
powerful task/agent system with typed outputs, artifacts, messaging, and
optional worktree isolation.

OMP is stronger for typed multi-agent artifacts, peer messaging, and isolated
workspaces. Felan is simpler when the primary coordination problem is “which
session-owned task is ready, who claimed it, and what verified result closed
it?”

### Configuration compatibility runs in opposite directions

OMP intentionally discovers multiple ecosystems and can reuse Claude, Cursor,
Codex, Cline, Windsurf, Gemini, Copilot, and other configuration shapes. Felan
intentionally does not discover ambient Pi extensions, prompts, project
settings, or foreign tool configuration. It reads the selected cwd instruction
file and explicit Felan agents/skills under its own host policy.

OMP therefore has a lower migration cost for a repository built around those
ecosystems. Felan has a smaller implicit resource surface and a clearer reason
for every loaded built-in.

### Both build on Pi lineage, but with different ownership choices

Felan wraps pinned `@earendil-works/pi-*` packages and keeps host policy and
portable extension behavior in separate layers. OMP's reviewed README describes
itself as a Pi fork with a much more opinionated native implementation. That
allows OMP to own a wide in-process tool/runtime surface; Felan keeps Pi as a
reviewed dependency boundary and emphasizes portable host contracts.

## Choose Felan when...

- your organization needs portable feature contracts across local and managed
  hosts;
- a shared prerequisite graph and same-session model handoff are more important
  than typed worktree fan-out;
- you want default SSRF protections, OAuth-only remote MCP, explicit browser
  attachment guidance, and untrusted-content boundaries;
- you prefer source-controlled built-ins over broad ambient configuration
  discovery; or
- you want local-first project memory as inspectable Markdown outside the repo.

## Choose Oh My Pi when...

- LSP, DAP, hashline/AST editing, embedded shell, or native performance are
  central requirements;
- typed subagent outputs, peer messaging, artifacts, worktrees, Agent Hub, or
  live collaboration matter;
- browser, Electron, desktop, image, voice, or persistent eval tools are needed;
- you want broad provider routing, local tiny models, or OMP's memory backends;
  or
- reusing foreign agent configuration and installing plugins/marketplace
  packages is a priority.

## Migration and interoperability

Felan and OMP can share ordinary repository files, but their resource discovery
policies are intentionally different. Felan does not load OMP plugins,
marketplaces, foreign skills, or OMP configuration automatically. OMP's broad
discovery should not be assumed to make Felan a drop-in replacement.

Felan's `.mcp.json` support is remote HTTP OAuth only and host-owned; OMP's MCP
surface is broader. Translate MCP transports and credentials explicitly. The
same model/provider account may still be usable when the host supports it, but
authentication, quotas, and configuration belong to each application.

## Trust and data boundaries

Felan's local host runs unsandboxed with current-user permissions, while its
web/MCP/browser/document/dependency paths apply explicit containment and
untrusted-data handling. OMP exposes more powerful local and remote surfaces,
so its own permissions, relay, browser, desktop, and plugin configuration must
be reviewed separately. Neither product label replaces host-level isolation.

See [Felan runtime and security](../concepts/runtime-and-security.md), the
[Oh My Pi repository](https://github.com/can1357/oh-my-pi/tree/54e1a8c900d30e5b6185975ab02a4a923faf1717),
and OMP's [MCP configuration](https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/mcp-config.md).

## Questions OMP users ask

### Can Felan run OMP extensions or plugins?

Not automatically. Felan's local TUI loads source-controlled built-ins only.
Port behavior into a Felan extension or compose a compatible package through an
explicit host integration.

### Does Felan have OMP's LSP or debugger?

Not in the reviewed local surface. Felan's comparison is intentionally candid:
OMP is the better fit when LSP, DAP, or native debugger workflows are required.

### Why choose Felan if both use Pi-related packages?

Felan's value is its ownership boundary: the portable Agent Core and extensions
can be embedded by different hosts, while the local TUI applies explicit
resource, credential, memory, web, MCP, and dependency policy.

## Sources and methodology

This page uses the dated [feature matrix](feature-matrix.md) and
[comparison methodology](methodology.md). Primary OMP references include the
[reviewed README](https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/README.md),
[todo](https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/tools/todo.md),
[task agents](https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/tools/task.md),
[context discovery](https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/context-files.md),
[Agent Hub](https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/agent-hub.md), and
[MCP](https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/mcp-config.md).

## Try Felan

```sh
npx @felan-ai/felan
```

Start with [Getting started](../getting-started.md) and
[architecture](../concepts/architecture.md).
