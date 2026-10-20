# Architecture

Felan separates **where a feature runs** from **what the feature does**. The
local daemon owns user state and policy; clients own presentation; portable extensions own feature
behavior; Agent Core owns the runtime-neutral composition boundary; and pinned
Pi packages provide the underlying model, session, and TUI machinery.

```text
  Felan clients -> local daemon         Felan cloud platform
  presentation    state · policy         tenant state · integrations · policy
             \                             /
              \                           /
               portable Felan extensions
                         |
                 @felan-ai/agent-core
                         |
             pinned @earendil-works/pi-*
```

The same agent-core and extension contracts can therefore run in more than one
host without moving local credential handling, storage, or presentation into a
portable package.

The Codebase Memory extension uses Agent Core's optional literal-argv stdio
process capability for a root-session-scoped warm MCP frontend shared by the
root agent and its subagents. This keeps protocol stdout separate from
diagnostics and leaves daemon coordination to the exact upstream binary; see
the [transport decision](../maintainers/codebase-memory-stdio.md). Its bounded
recovery wave coordinates only Felan-owned frontends and uses the upstream
daemon's graceful stop command; it does not mutate upstream coordination state.

## Ownership layers

| Layer | Owns | Does not own |
| --- | --- | --- |
| `apps/felan` | CLI/TUI, ACP, headless, local onboarding presentation | Daemon implementation or cloud policy |
| `apps/daemon` | Local credentials, settings, session and agent paths, model scope, built-in allowlist, execution, descendants and lifecycle | Dependency on the Felan client application |
| `packages/ext-*` | Feature schemas, lifecycle behavior, validation, model-facing tools, and host interfaces for one capability | Ambient discovery, credentials, browser callbacks, or application-specific storage unless explicitly defined by its contract |
| `@felan-ai/agent-core` | `AgentRuntime`, host runtime, base prompt, cwd instructions, model tiers, coding tools, capabilities, resource/session composition, and the public Pi composition surface | Tasks, memory scheduling, Prewalk, local settings, feature policy, and UI |
| Pinned Pi packages | Provider adapters, session machinery, extension API, model streams, and core TUI primitives | Felan's host policy and feature ownership |

The dependency direction is intentionally one-way: `apps/felan` installs the
exact `apps/daemon` package; the daemon composes extensions, extensions consume
Agent Core contracts, and Agent Core composes the pinned Pi surface. Feature
packages should not import either application. TUI, ACP, and headless are daemon
clients; client-local themes are not daemon state. The Pi SDK also transitively
includes `pi-tui`; no terminal-free payload is claimed.

## Session composition

For every root session the local host:

1. chooses the working directory and agent directory;
2. creates a host-path `AgentRuntime` and scoped session/agent storage;
3. loads filtered Felan Code settings and the allowed built-in packages;
4. selects explicit Agent Skills and the cwd-level `AGENTS.md`/`CLAUDE.md`
   file, then delivers it as hidden user-role request context outside the system
   prompt;
5. binds daemon-owned adapters such as OAuth storage, dependency onboarding, and
   memory coordination, while the client binds presentation; and
6. creates the Pi session and sends projections to attached clients.

New, resumed, forked, cloned, and imported root sessions receive the same
composition process. Nested subagents receive their own session history while
sharing the root session's extension storage and local host policy.

Agent Core's `createAgentCoreSession` and
`createAgentCoreSessionRuntimeFactory` expose the portable seam. Consumers pass
credentials, model scope, storage, settings, inline extensions, and presentation
listeners; Agent Core does not discover a consumer's ambient resources.

## Runtime contracts

`AgentRuntime` is the adapter-neutral I/O boundary used by portable features:

- `exec(command, args)` preserves literal argument boundaries;
- `shell(command)` is available only when shell parsing is intentional;
- byte-based reads and writes preserve binary data;
- bounded reads and exclusive writes support safe extension behavior;
- bounded file enumeration and command-output capture prevent broad searches
  from materializing unbounded host data;
- scoped `storage('session')` and `storage('agent')` contain extension state;
- optional persistent process, PTY, logger, and classifier capabilities are
  explicit; and
- host implementations decide whether workspace or current-user host paths are
  available.

`HostAgentRuntime` can use cwd-contained paths or explicitly use current-user
host paths. Neither mode is an OS sandbox; the host must supply isolation when
untrusted workloads require it.

## Resource policy

The local application uses a fixed resource boundary. It imports only
source-controlled built-ins, Felan-owned settings and prompt appends, explicit
agent definitions, explicit Agent Skills, and the Agent Core-selected cwd
instruction file, plus external extension paths explicitly supplied by local
clients and optional standard Pi extension directories configured per host.
Ambient Pi packages, prompts, themes, project settings, and package resources
are filtered. `piExtensions.user` and `piExtensions.project` default to off
and apply to every newly created root, including ACP, headless, web-created
and imported sessions. Children load their root's external extension paths;
worker tool allowlists still limit active tools.

Project extensions require Felan folder trust, directly or through a parent.
Only the creating TUI may prompt; other creators skip folders without a
decision and save none. Remote creates cannot supply explicit paths. Paths are
fixed at creation: resume and clone/fork retain saved paths, while adoption of
an unindexed transcript loads none. The separate `piExtensions.llamaCpp`
integration remains root-only for any client, not inherited by children.

This boundary is part of the local host, not a promise that every Felan host
will make the same policy decision. The Felan cloud platform can provide
different credentials, storage, integrations, and approval controls while
preserving the portable feature contracts.

## Why Felan wraps Pi

Felan consumes pinned `@earendil-works/pi-*` packages rather than maintaining a
source fork. Pi supplies the provider, session, extension, and TUI primitives;
Felan composes them with host-owned policy and portable contracts. Updating Pi
is consequently a reviewed dependency change instead of a long-lived merge
burden, while Felan's feature behavior remains in its owning layer.

## Adding a feature

When extending Felan:

1. put portable schemas and behavior in the owning `packages/ext-*` package;
2. expose host actions through an explicit adapter interface;
3. keep credentials, storage mapping, installation, and presentation in the
   host that owns them;
4. route process and filesystem work through `AgentRuntime`; and
5. add package-level build, type-check, test, and boundary coverage.

See the [maintainer architecture map](../maintainers/architecture-map.md) for
source starting points and verification commands.
