# Extension catalog

Felan publishes portable packages under `@felan-ai/*`. The local TUI composes
only the source-controlled built-ins listed here; it does not discover ambient
Pi extensions or arbitrary npm packages.

## Composition layers

| Package | Capability | Local TUI surface | Conditions |
| --- | --- | --- | --- |
| [`@felan-ai/felan`](../../apps/tui/README.md) | Account-free local terminal host | `felan` binary and interactive TUI | Node.js 22.19.0 or newer; provider credentials configured locally |
| [`@felan-ai/agent-core`](../../packages/agent-core/README.md) | Runtime contracts, base prompt, coding tools, Pi composition | Local host runtime | Required by extensions |
| [`@felan-ai/ext-subagents`](../../packages/ext-subagents/README.md) | Asynchronous child agents and lifecycle tools | `/agents`, `Alt+A`, agent rail | Local host supplies `SubagentHost` |
| [`@felan-ai/ext-ask-user`](../../packages/ext-ask-user/README.md) | One-question and one-to-four-question structured input | TUI question wizard | Host supplies `AskUserHost` |
| [`@felan-ai/ext-tasks`](../../packages/ext-tasks/README.md) | Shared dependency-aware session task graph | `/tasks`, `Ctrl+Shift+T` | Session storage required |
| [`@felan-ai/ext-prewalk`](../../packages/ext-prewalk/README.md) | Same-session planner-to-implementation handoff | `/prewalk` | Authenticated target model and explicit mutation tool |
| [`@felan-ai/ext-context`](../../packages/ext-context/README.md) | Progressive nested `AGENTS.md`/`CLAUDE.md` loading | `/progressive-context` | Structured reads or decoded `@file` blocks |
| [`@felan-ai/ext-context-view`](../../packages/ext-context-view/README.md) | Estimated context-window usage inspector | `/context` | Inline by default, optional TUI overlay, or compact headless report |
| [`@felan-ai/ext-insights`](../../packages/ext-insights/README.md) | Local session analytics reports | `/insights` | Host-owned bounded session discovery and report storage |
| [`@felan-ai/ext-prompt-history`](../../packages/ext-prompt-history/README.md) | Prompt history search | `Ctrl+R`, `Cmd+R` | TUI-only; inline by default, optional overlay |
| [`@felan-ai/ext-memory`](../../packages/ext-memory/README.md) | Portable Markdown memory schema and checkpoint integration | `/memory` through local host | Host supplies memory coordinator for processing |
| [`@felan-ai/ext-output-style`](../../packages/ext-output-style/README.md) | Validated model-response style instructions | Root and child system prompts | Host selects a built-in style or supplies explicit `custom` instructions; no ambient prompt loading |
| [`@felan-ai/ext-web-access`](../../packages/ext-web-access/README.md) | Bounded URL discovery and matching text/PDF passages | `web_search`, `fetch_content` | Provider credentials/endpoints, PDF limits, domain policy, and SSRF ranges |
| [`@felan-ai/ext-mcp`](../../packages/ext-mcp/README.md) | OAuth-only remote MCP gateway | `/mcp` | Local host supplies OAuth credentials/callbacks |
| [`@felan-ai/ext-felan-api`](../../packages/ext-felan-api/README.md) | Single authenticated Felan REST API gateway | `felan_api` | `FELAN_API_KEY` or explicit factory `apiKey`; local built-in is disabled when no key is present |
| [`@felan-ai/ext-browser`](../../packages/ext-browser/README.md) | Reviewed `agent-browser` CLI integration | Model-facing `browser` tool | Reviewed CLI; Chrome is separate |
| [`@felan-ai/ext-markitdown`](../../packages/ext-markitdown/README.md) | Bounded office-document conversion through `read` | `/markitdown` | Managed `markitdown` executable |
| [`@felan-ai/ext-background-bash`](../../packages/ext-background-bash/README.md) | Detached process registry and logs | `/background-bash`, `Ctrl+Shift+J` | POSIX process utilities; non-OpenAI-family models |
| [`@felan-ai/ext-codex`](../../packages/ext-codex/README.md) | GPT-specific exec, patch, PTY, and image tools | Model-selected tool replacement | GPT model on exact `openai`/`openai-codex` provider |
| [`@felan-ai/ext-rtk-optimizer`](../../packages/ext-rtk-optimizer/README.md) | Command rewriting and output compaction | `/rtk` | Compaction ships; rewriting needs `rtk` |
| [`@felan-ai/ext-codebase-memory`](../../packages/ext-codebase-memory/README.md) | Structural code index, symbol reads, and bounded grep augmentation | `/codebase-memory` and four model tools | Exact reviewed `codebase-memory-mcp` 0.10.8 binary |
| [`@felan-ai/ext-powerline`](../../packages/ext-powerline/README.md) | ANSI-aware local status footer | TUI footer | TUI sessions only; enabled by default locally |

## Host ownership rules

Portable extensions own schemas, validation, lifecycle behavior, and
model-facing contracts. Hosts own credentials, storage roots, installation,
browser callbacks, presentation, admission policy, and cloud/team integration.
The package README for each extension is the API and development reference.

## Local defaults

Every listed built-in is enabled unless its key is explicitly set to `false` in
`$FELAN_AGENT_DIR/settings.json`. Binary-backed features can still remain
inactive when their runtime dependency is unavailable. The local host offers
interactive dependency onboarding; cloud and headless hosts should preinstall
dependencies or disable the affected feature.

The Powerline package is hostless by default, but the local TUI binds it to
local subscription usage and enables it by default. Set
`builtinExtensions.powerline` to `false` to disable it.

See [Configuration](../user-guide/configuration.md),
[Runtime dependencies](runtime-dependencies.md), and
[Runtime and security](../concepts/runtime-and-security.md).
