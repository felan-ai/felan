# @felan-ai/ext-subagents

Portable subagent protocol and model-facing tools for Felan. Applications
provide a `SubagentHost` to `createSubagentsExtension(host)` and bind the
resulting parent-session lifecycle with `bindSubagentSession(...)` before the
session is activated.

The extension registers exactly `Agent`, `list_subagents`,
`get_subagent_result`, `steer_subagent`, and `cancel_subagent`. It owns shared
schemas, defaults, validation, and normalized text results while the host owns
execution, latest records, continuation, persistence, completion delivery, and policy.
Agent Core remains unaware of subagents and provides only generic runtime,
session, coding-tool, and extension composition.

Ambient Pi agent and extension discovery is outside this package and remains
disabled by Felan applications.

## Development

Source: `packages/ext-subagents` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-subagents build
pnpm --filter @felan-ai/ext-subagents test
```

## Attribution

The architecture was informed by the MIT-licensed `pi-subagents` project. See
[NOTICE](NOTICE) for the reviewed source and commit.
