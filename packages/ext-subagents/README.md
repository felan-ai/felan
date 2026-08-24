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

`max_turns` is a hard assistant-turn budget. A child that reaches the budget
while it still has tool work is cancelled with `turn_limit_reached`; callers
should leave enough budget for a final textual result. The local host reserves
that outcome separately from provider failures, parent cancellation, timeouts,
and host shutdown. A retained child may be explicitly continued when its
session history is available; Felan never replays interrupted work
automatically after a restart.

Terminal errors use stable codes: `model_request_failed`,
`cancelled_by_parent`, `timed_out`, `host_shutdown`, and
`turn_limit_reached`. `host_unavailable` is reserved for an unavailable host
or parent, and `internal_error` is reserved for unexpected runtime failures.

During initialization the extension registers a `subagents` capability with
generic delegation and control guidance plus the current host's available agent
types and descriptions. The contribution is present only when this extension is
loaded.

Ambient Pi agent and extension discovery is outside this package and remains
disabled by Felan applications.

## Installation and composition

```ts
import { createSubagentsExtension } from '@felan-ai/ext-subagents';

const extension = createSubagentsExtension(host);
```

The `host` implements `SubagentHost` and owns execution, admission, records,
persistence, continuation, nesting, cancellation, and completion delivery. A
local TUI may add a navigator; a cloud host may provide a different
presentation without changing the portable tool contract.

## Package boundary and requirements

This package owns exactly five model-facing tools, their schemas, validation,
normalized results, host binding, and model-tier resolution. It does not load
ambient agents/extensions and does not execute child sessions itself. It
requires a compatible `@felan-ai/agent-core` peer and TypeBox.

## Development

Source: `packages/ext-subagents` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-subagents build
pnpm --filter @felan-ai/ext-subagents type-check
pnpm --filter @felan-ai/ext-subagents test
```

## Attribution

The architecture was informed by the MIT-licensed `pi-subagents` project. See
[NOTICE](NOTICE) and [LICENSE](LICENSE) for the reviewed source and commit.

## Related documentation

- [Agents, tasks, and Prewalk](../../docs/user-guide/agents-tasks-and-prewalk.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)
- [Architecture](../../docs/concepts/architecture.md)
