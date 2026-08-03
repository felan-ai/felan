# @felan-ai/felan

Local, account-free Felan terminal agent built on `@felan-ai/agent-core` and
Pi's interactive TUI.

```sh
npx @felan-ai/felan
```

The package exposes the `felan` binary. It stores model credentials, settings,
and sessions under `~/.felan/agent` by default; set `FELAN_AGENT_DIR` to select
another local directory. Use `/login` inside the TUI to configure provider-owned
model credentials without a Felan account.

Each session uses a cwd-bound `HostAgentRuntime`. Pi's session runtime recreates
the host runtime, filtered settings, resources, and session composition for
new, resume, fork, clone, and import flows, then rebinds the active interactive
UI. Host mode uses the current user's filesystem and process permissions and is
not an isolation boundary.

Only the source-controlled Felan extension package list is imported. Ambient Pi
packages, extensions, skills, prompts, themes, and context files remain filtered;
inline Felan extensions can still provide shared tools, prompts, interaction,
and subagent behavior. The default local list includes `@felan-ai/ext-powerline`
for an ANSI-aware footer; it is a direct TUI dependency and is not part of any
cloud composition. Agent Core's `spawn_agent` tool delegates child creation
through the portable host contract; local children run as in-process Agent Core
sessions on fresh host runtimes without Felan cloud services.

```sh
felan --diagnostics
```

Diagnostics include the Felan, Agent Core, Pi, and Node.js versions.
