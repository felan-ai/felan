<h1 align="center">Felan</h1>

<p align="center">
  <strong>One agent core, from your terminal to your team.</strong><br>
  An open-source coding agent for local development and the shared agent runtime behind <a href="https://felan.ai">felan.ai</a>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@felan-ai/felan"><img src="https://img.shields.io/npm/v/@felan-ai/felan?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/felan-ai/felan/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/felan-ai/felan/ci.yml?branch=main&style=flat&label=CI&colorA=222222&colorB=3FB950" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/felan-ai/felan?style=flat&colorA=222222&colorB=58A6FF" alt="MIT license"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.19-5FA04E?style=flat&colorA=222222" alt="Node.js 22.19 or newer"></a>
</p>

Felan is a model-portable coding agent for software development work. It pairs
a host-owned runtime and controlled resource policy with first-party extensions
for parallel agents, planning, task coordination, human input, project context,
web research, and external tools.

**Felan wraps [Pi](https://github.com/earendil-works/pi); it does not fork Pi.**
It consumes pinned `@earendil-works/pi-*` packages and composes their model,
session, TUI, and extension APIs with Felan's own agent core, runtime contracts,
storage, policy, and presentation.

## Install

Felan requires Node.js 22.19.0 or newer.

Run it without a global install:

```sh
npx @felan-ai/felan
```

Or install the `felan` command:

```sh
npm install --global @felan-ai/felan
felan
```

On first launch, run `/login` inside the TUI to connect a supported model
provider. Provider credentials are managed locally and no Felan account is
required.

```sh
felan "inspect this project"
felan --continue
felan --diagnostics
```

Settings, sessions, agents, and runtime state live under `~/.felan` by default.
Set `FELAN_AGENT_DIR` to use another directory.

> [!IMPORTANT]
> The local agent runs with your user's filesystem and process permissions. It
> is a host application, not a sandbox.

## One agent, two ways to run it

The local CLI is not a separate demo. It bundles the same Felan Agent Core that
runs inside the SaaS product at [felan.ai](https://felan.ai).

| Local Felan | Felan SaaS |
| --- | --- |
| Runs on your machine from the `@felan-ai/felan` package | Runs as managed cloud background agents |
| Uses provider-owned credentials without a Felan account | Adds team workflows, triggers, integrations, shared knowledge, visibility, and guardrails |
| Stores local sessions and state under `~/.felan` | Hosts resumable and shareable sessions for the team |

Both surfaces use the same portable agent core and extension contracts; each
host owns its credentials, storage, policy, integrations, and presentation.
This repository contains that open agent layer, its first-party extensions, and
the local terminal host. It does not contain the full SaaS application.

## Built to keep software work moving

### 01 · Delegate work, then inspect it live

Spawn tracked subagents asynchronously, keep working while they run, and get
completion notices when results are ready. Children can be listed, steered,
continued, or cancelled. The local agent navigator shows live transcripts for
bounded, nested agent trees without hiding them behind a single tool call.

### 02 · Share the plan, not just the prompt

The root agent and every subagent share one dependency-aware task graph with
stable IDs, priorities, prerequisites, ownership, acceptance criteria, and
verified results. `/tasks` opens list, detail, and graph views in the TUI.

`/prewalk` keeps planning and implementation in one trajectory: the current
model explores and plans, makes the first focused mutation, then switches the
same conversation and tool history to a configured authenticated model tier or
exact model to finish and verify the work.

### 03 · Ask before guessing

The `ask_user` tool gives the agent a structured way to pause for input. The
local host renders single questions or one-to-four-question wizards with
searchable choices, multi-select, freeform answers, and optional comments.

### 04 · Load context where it applies

Agent Core loads at most one cwd-level `AGENTS.md` or `CLAUDE.md`, while
progressive context discovers nested instructions as the agent reads deeper
into the repository. Explicit global and workspace Agent Skills are available
to the root and its children, and discovered instructions survive context
compaction.

### 05 · Research the web with explicit boundaries

Search with OpenAI, Exa, Brave, or self-hosted SearXNG; verify claims against
exact source passages; and fetch pages, PDFs, images, or GitHub repositories.
Remote material is bounded and marked as untrusted before it reaches the model,
and private-network destinations are blocked by default.

### 06 · Connect MCP without opening every door

Felan exposes remote MCP servers through one token-efficient, OAuth-only
gateway. The local host owns browser authentication and OS credential storage.
Ambient MCP discovery, stdio servers, bearer tokens, custom headers, and direct
tool injection remain outside the allowed surface.

### 07 · Give each model the tools it expects

GPT-family models on the exact `openai` and `openai-codex` providers receive
structured `exec_command`, `write_stdin`, `apply_patch`, and optional
`view_image` tools. Other model selections keep the ordinary runtime-backed
coding tools. Models outside those two providers can also launch detached
background Bash jobs. The RTK optimizer compacts noisy output and, when `rtk`
is installed, uses it to rewrite supported commands.

### 08 · Keep long terminal sessions readable

The TUI groups adjacent tool activity into compact summaries, with `Ctrl+O` to
toggle detail and `/tools` to inspect complete calls. Agent, task, and process
navigators keep concurrent work visible, while the powerline tracks Git, model,
session, subscription, context, and extension status.

## Built on Pi, without becoming a Pi fork

```text
@felan-ai/felan local host              felan.ai cloud host
                \                        /
                 portable Felan extensions
                            |
                 @felan-ai/agent-core
                            |
              pinned @earendil-works/pi-* packages
```

Pi provides the underlying model adapters, session machinery, extension
lifecycle, and interactive terminal UI. Agent Core composes Pi sessions with
Felan's base prompt, runtime-backed coding tools, explicit resources, and
enabled capabilities. Applications remain responsible for credentials,
storage, host I/O, policy, and presentation.

That boundary is deliberate: updating Pi is a pinned dependency change, not a
merge from a long-lived source fork. Felan can evolve its portable contracts
and product behavior without carrying a divergent Pi codebase.

Many extensions are portable adaptations of, or were designed with reference
to, existing Pi extensions. Their immutable adaptation sources and latest
reviewed upstream checkpoints are recorded in
[Upstream extension review baselines](docs/upstream-extensions.md), including
reviews where no change was ported.

External executable detection, safe degradation, local onboarding, and cloud
preinstallation responsibilities are documented in
[Runtime dependencies](docs/runtime-dependencies.md).

The local host loads only Felan's source-controlled built-in extensions. It
does not discover ambient Pi extensions, prompts, project settings, or package
resources. Built-ins are enabled by default and can be toggled in
`~/.felan/settings.json`. See the [local TUI documentation](apps/tui/README.md)
for commands, configuration, and extension-specific controls.

For a source-backed local feature matrix covering Codex, OpenCode, Claude Code,
Pi, and Oh My Pi—including tasks, agents, context, web research, execution,
safety, and features Felan lacks—see the
[coding-agent comparison](docs/comparison.md).

## Repository map

| Package | Purpose |
| --- | --- |
| `@felan-ai/felan` | Account-free local terminal application and `felan` binary |
| `@felan-ai/agent-core` | Portable runtime contracts, Node.js host runtime, prompt, tools, and Pi session composition |
| `@felan-ai/ext-subagents` | Tracked asynchronous subagent protocol and tools |
| `@felan-ai/ext-ask-user` | Structured interactive questions with host-owned presentation |
| `@felan-ai/ext-tasks` | Dependency-aware task graph shared across a root session and its children |
| `@felan-ai/ext-context` | Progressive loading of nested project instructions |
| `@felan-ai/ext-prewalk` | Same-session planner-to-implementation model handoff |
| `@felan-ai/ext-markitdown` | Bounded binary-document conversion through the ordinary read workflow |
| `@felan-ai/ext-background-bash` | Detached Bash processes for models outside `openai` and `openai-codex` |
| `@felan-ai/ext-web-access` | Bounded web research and content retrieval with SSRF protections |
| `@felan-ai/ext-mcp` | Portable OAuth-only remote MCP gateway |
| `@felan-ai/ext-codex` | GPT-specific command, patch, image, and OpenAI Responses controls |
| `@felan-ai/ext-rtk-optimizer` | RTK command rewriting and tool-output compaction |
| `@felan-ai/ext-powerline` | ANSI-aware local TUI status footer |

## Develop from source

Development and CI use Node.js 22.20.0 and pnpm 9.15.5.

```sh
git clone https://github.com/felan-ai/felan.git
cd felan
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/tui/dist/cli.js
```

Run the complete build, type-check, test, license, and packed-install suite with:

```sh
pnpm verify
```

See [Contributing](CONTRIBUTING.md) and the [Release process](docs/releasing.md).

## Community

[Join the Felan Discord community](https://discord.gg/skNd4GSzZ) to connect with
other users and contributors.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for third-party attribution.
