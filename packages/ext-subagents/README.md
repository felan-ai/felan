# @felan-ai/ext-subagents

Portable subagent protocol and model-facing tools for Felan. Applications
provide a `SubagentHost` to `createSubagentsExtension(host)` and bind the
resulting parent-session lifecycle with `bindSubagentSession(...)` before the
session is activated.

The extension registers exactly `Agent`, `list_subagents`,
`get_subagent_result`, `steer_subagent`, and `cancel_subagent`. It owns shared
schemas, defaults, validation, and normalized text results while the host owns
execution, latest records, continuation, persistence, completion delivery, and policy.
Agent Core remains unaware of subagent execution and provides generic runtime,
session, coding-tool, extension composition, and model-tier selection.

The `Agent` tool accepts `inherit`, `high`, `medium`, `low`, or an exact
`provider/model-id` in its `model` field. Tier selection uses the models already
allowed and authenticated for the active session, prefers the parent model's
provider and family, and sends the resolved exact model reference to the host.
Model tiers do not imply a thinking level. A descriptor's `model` and `thinking`
settings are authoritative. When a definition omits either setting, the
corresponding explicit tool argument applies; when both omit it, the parent
setting is inherited. Extension-facing thinking accepts `off`, `low`, `medium`,
`high`, `xhigh`, and `max`; an inherited Pi `minimal` level normalizes to `low`.

All child launches are asynchronous and return after admission. Result reads
return the latest record immediately, while completion notices surface finished
work to the parent session. Notices steer active parent work at the next
model-call boundary and trigger a turn when the parent is idle.

During initialization the extension registers a `subagents` capability with
generic delegation and control guidance plus the current host's available agent
types and descriptions. The contribution is present only when this extension is
loaded.

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
