# @felan-ai/felan

Local, account-free Felan terminal agent built on `@felan-ai/agent-core` and
Pi's interactive TUI.

```sh
npx @felan-ai/felan
```

The package exposes the `felan` binary. It owns local credentials, settings,
session and agent storage paths, built-in extension selection, dependency
onboarding, lifecycle, and TUI presentation. Portable feature behavior remains
in the `@felan-ai/ext-*` packages.

> [!IMPORTANT]
> The local host uses the current user's filesystem and process permissions. It
> is not a sandbox.

## Requirements and quick start

Felan supports Node.js 22.19.0 or newer. Repository development and CI use
Node.js 22.20.0 with pnpm 9.15.5.

```sh
felan
/login
```

Run an initial prompt or continue the most recent session for the current
directory:

```sh
felan "inspect this project"
felan --continue
```

## CLI

```text
felan [options] [message]

-c, --continue     Continue the most recent session for this directory
--diagnostics      Print runtime versions and configuration mode
update             Update a global npm installation of Felan
-h, --help         Show help
-v, --version      Print the Felan version
--verbose          Show verbose startup details
```

Run `felan update` to check the stable npm release. It updates only a verified
global npm installation, reports when the installation is current, and tells
you to restart after a successful update. `npx`, local/source, and other
package-manager installations are not changed; update those with the command
that installed them.

Invocations that start or continue an agent session launch the interactive TUI.
`felan update` and informational flags exit without starting a session. Internal
headless modes used by subagents and extension adapters are not public CLI entry
points.

`felan --diagnostics` reports Felan, Agent Core, Pi, and Node.js versions plus
runtime and credential modes.

## Local state and policy

The default agent directory is `~/.felan`; set `FELAN_AGENT_DIR` to change it.
It contains local credentials, settings, sessions, agents, extension storage,
and project memory. Root-session storage is scoped under
`$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>` and longer-lived
extension state under `$FELAN_AGENT_DIR/storage/agent`.

The local host loads only source-controlled Felan built-ins, Felan-owned
settings and prompt appends, explicit Felan agents and Agent Skills, and the
Agent Core-selected cwd instruction file. Ambient Pi extensions, packages,
prompts, themes, project settings, and package resources are filtered.

All built-ins are enabled by default, including the Powerline footer in TUI
sessions. Binary-backed features can remain inactive until their dependency is
installed or the feature is disabled through `/dependencies`.

Model responses use the built-in `concise` output style by default. Set the
global `outputStyle` setting to `explanatory` for more reasoning and context;
the [configuration guide](../../docs/user-guide/configuration.md#output-style)
documents validation and session-lifecycle behavior.

## Canonical user documentation

The package README intentionally stays short. Use these guides for operational
details:

- [Getting started](../../docs/getting-started.md)
- [Local CLI and storage](../../docs/user-guide/local-cli.md)
- [Configuration](../../docs/user-guide/configuration.md)
- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Agents, tasks, and Prewalk](../../docs/user-guide/agents-tasks-and-prewalk.md)
- [Context and memory](../../docs/user-guide/context-and-memory.md)
- [Web, MCP, browser, and documents](../../docs/user-guide/web-mcp-and-browser.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)

## Development

Source: `apps/tui` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/felan build
pnpm --filter @felan-ai/felan type-check
pnpm --filter @felan-ai/felan test
```

Run `pnpm verify` from the repository root for cross-package and packed-binary
coverage.
