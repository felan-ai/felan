# Felan documentation

Felan is an open-source, model-portable coding agent with a local terminal host
and a portable agent core used by both local and managed hosts. Start with the
path that matches what you are trying to do.

## Use Felan locally

- [Getting started](getting-started.md) — install Felan, connect a model, and
  run the first session.
- [Local CLI](user-guide/local-cli.md) — invocation, sessions, storage, and the
  local resource policy.
- [Configuration](user-guide/configuration.md) — settings, built-ins, agent
  definitions, skills, and feature-specific files.
- [Commands and shortcuts](user-guide/commands-and-shortcuts.md) — Felan-owned
  commands and navigation controls.
- [Agents, tasks, and Prewalk](user-guide/agents-tasks-and-prewalk.md) — parallel
  work, the shared task graph, and same-session model handoff.
- [Context and memory](user-guide/context-and-memory.md) — project
  instructions, Agent Skills, and local-first project memory.
- [Web, MCP, browser, and documents](user-guide/web-mcp-and-browser.md) —
  bounded research and external-tool workflows.

## Understand the system

- [Architecture](concepts/architecture.md) — ownership from the local host,
  through extensions, to Agent Core and Pi.
- [Runtime and security](concepts/runtime-and-security.md) — permissions,
  trusted boundaries, credentials, and untrusted content.
- [Local memory architecture](concepts/local-memory.md) — checkpointing,
  staging, validation, publication, and session projections.
- [Extension catalog](reference/extension-catalog.md) — every first-party
  package, its host boundary, commands, and runtime conditions.
- [Runtime dependencies](reference/runtime-dependencies.md) — external
  executables, onboarding, and unavailable behavior.

## Integrate Felan

- [`@felan-ai/agent-core`](../packages/agent-core/README.md) — portable runtime
  contracts and Pi session composition.
- [Extension catalog](reference/extension-catalog.md) — entry points for all
  first-party extensions.
- [Architecture](concepts/architecture.md) — what belongs to a host versus a
  portable extension.

### Package README index

The package READMEs are the canonical npm-facing API and development references:

- [`@felan-ai/felan`](../apps/tui/README.md)
- [`@felan-ai/agent-core`](../packages/agent-core/README.md)
- [`@felan-ai/ext-ask-user`](../packages/ext-ask-user/README.md)
- [`@felan-ai/ext-background-bash`](../packages/ext-background-bash/README.md)
- [`@felan-ai/ext-browser`](../packages/ext-browser/README.md)
- [`@felan-ai/ext-codex`](../packages/ext-codex/README.md)
- [`@felan-ai/ext-context`](../packages/ext-context/README.md)
- [`@felan-ai/ext-markitdown`](../packages/ext-markitdown/README.md)
- [`@felan-ai/ext-mcp`](../packages/ext-mcp/README.md)
- [`@felan-ai/ext-felan-api`](../packages/ext-felan-api/README.md)
- [`@felan-ai/ext-memory`](../packages/ext-memory/README.md)
- [`@felan-ai/ext-output-style`](../packages/ext-output-style/README.md)
- [`@felan-ai/ext-powerline`](../packages/ext-powerline/README.md)
- [`@felan-ai/ext-prewalk`](../packages/ext-prewalk/README.md)
- [`@felan-ai/ext-rtk-optimizer`](../packages/ext-rtk-optimizer/README.md)
- [`@felan-ai/ext-subagents`](../packages/ext-subagents/README.md)
- [`@felan-ai/ext-tasks`](../packages/ext-tasks/README.md)
- [`@felan-ai/ext-web-access`](../packages/ext-web-access/README.md)

Felan's local application loads only source-controlled built-ins. Public
extension packages are composition building blocks for Felan hosts; they are
not ambient plugins automatically discovered by the local CLI.

## Compare local coding agents

- [Comparison guide](comparisons/README.md) — choose a focused comparison.
- [Felan vs Codex](comparisons/codex.md)
- [Felan vs OpenCode](comparisons/opencode.md)
- [Felan vs Claude Code](comparisons/claude-code.md)
- [Felan vs Pi](comparisons/pi.md)
- [Felan vs Oh My Pi](comparisons/oh-my-pi.md)
- [Technical feature matrix](comparisons/feature-matrix.md)
- [Sources and methodology](comparisons/methodology.md)

Comparison pages are dated source reviews of local terminal behavior. They do
not compare model quality, pricing, or separate web and IDE products.

The previous top-level paths remain compatibility pages:

- [Legacy comparison path](comparison.md)
- [Legacy release path](releasing.md)
- [Legacy runtime-dependency path](runtime-dependencies.md)
- [Legacy upstream-review path](upstream-extensions.md)

## Contribute and maintain

- [Contributing](../CONTRIBUTING.md) — setup and contribution expectations.
- [Architecture map](maintainers/architecture-map.md) — code ownership,
  starting points, and verification commands.
- [Savings metrics design](maintainers/savings-metrics-design.md) — working
  proposal for extension reporting, local persistence, and gain reports.
- [Release process](maintainers/releasing.md) — package selection, trusted
  publishing, and packed audits.
- [Upstream extension reviews](maintainers/upstream-extensions.md) — immutable
  adaptation and review baselines.

## Documentation ownership

To keep details from drifting:

- the root [`README.md`](../README.md) owns product positioning and the first
  successful run;
- `docs/user-guide/` owns local user workflows and configuration;
- `docs/concepts/` owns architecture and trust boundaries;
- package READMEs own public APIs, host contracts, and package development;
- `docs/maintainers/` owns release and provenance procedures; and
- `docs/comparisons/` owns dated competitor claims and source snapshots.
