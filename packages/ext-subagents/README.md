# @felan-ai/ext-subagents

Portable subagent tools built on Agent Core's `felan.sessions@1` contract.
The default extension registers exactly `Agent`, `list_subagents`,
`get_subagent_result`, `steer_subagent`, and `cancel_subagent`. It owns agent
definitions, routing, model selection, and normalized results. The provider
admits child sessions into the daemon registry and owns execution limits,
persistence, continuation, completion delivery, and shutdown. Local concurrency
and depth are configured through `felanSubagents.concurrency` and
`felanSubagents.maxDepth` (defaults: four and three).
No extension-specific service or custom presenter is required.

The `Agent` tool accepts `inherit`, `xhigh`, `high`, `medium`, `low`, or an exact
`provider/model-id` in its `model` field. Tier selection uses the models already
allowed and authenticated for the active session, prefers the parent model's
provider and family, and sends the resolved exact model reference to the host.
Use `xhigh` selectively for unusually complex architecture, design, planning,
difficult debugging, or high-stakes code review; it is not intended for routine
delegation.
Model tiers do not imply a thinking level. A descriptor's `model` and `thinking`
settings are authoritative. When a definition omits either setting, the
corresponding explicit tool argument applies; when both omit it, the parent
setting is inherited. Extension-facing thinking accepts `off`, `low`, `medium`,
`high`, `xhigh`, and `max`; an inherited Pi `minimal` level normalizes to `low`.

All child launches are asynchronous and return after admission. Result reads
return the latest record immediately, while completion notices surface finished
work to the parent session. Notices steer active parent work at the next
model-call boundary, and notices arriving together are delivered in one parent
turn. Use `acknowledge_completion: true` with `get_subagent_result` when the
terminal result has been handled and its pending notice should be suppressed;
the default remains non-consuming. Continuing a child supersedes its prior
undelivered notice. Delegated tasks should have disjoint scopes; the parent
should yield when no independent work remains, cancel a child before taking
over its unfinished scope, and use the shared task graph's session ownership
instead of force-recovering another worker's active task.

`list_subagents` returns compact status records, omits result and error bodies,
and is bounded to 20 records by default (50 maximum). A bounded response tells
the caller to use `get_subagent_result` for a specific child.

`max_turns` is a hard assistant-turn budget. The local host reserves the final
turn for a tool-free synthesis response. A child that still requests tool work
at that boundary is cancelled with `turn_limit_reached`; callers should leave
enough budget for the final textual result. The local host reserves that
outcome separately from provider failures, parent cancellation, timeouts, and
host shutdown. A retained child may be explicitly continued when its session
history is available; Felan never replays interrupted work automatically after
a restart.

Terminal errors use stable codes: `model_request_failed`,
`cancelled_by_parent`, `timed_out`, `host_shutdown`, and
`turn_limit_reached`. `host_unavailable` is reserved for an unavailable host
or parent, and `internal_error` is reserved for unexpected runtime failures.

The persistent capability guidance, including the complete host catalog, stays
in the system prompt whenever the extension is enabled. It describes when a child
pays off: broad discovery across many unknown files on a cheaper model that
returns a compact summary, an independent review or completion check in a fresh
context, or independent tasks with disjoint file scopes that can run in
parallel. It keeps small, sequential, known-location, and critical-path work in
the parent, and rules out re-reading a delegated scope, trivial delegation, and
reviewer fan-out. Without a classifier, the model applies that guidance itself.

With a composed root classifier registry and an `explore` definition, the
`subagents` contribution adds a `broad_discovery` question to the shared entry
pass. It consumes the shared result in `before_agent_start`; there is no separate
per-input inference call. The shared budget may expire without guidance. Prompt
expansion cancels the earlier pass and builds a new shared snapshot. Without the
registry, static guidance remains available. A bounded file listing skips discovery classification
for a repository with fewer than 20 files, since delegating that surface
would add overhead. At a probability of 0.65 or higher, the `subagent_routing`
system-prompt section directs the model to delegate discovery to `explore`
children and wait for their summaries rather than reading those scopes itself.
Below the threshold, or when classification fails, no section is added and the
user request is never blocked. Child sessions never classify. One-shot print
and JSON modes do not classify discovery: they exit when the parent first
settles and cannot deliver a child's later completion into that run.

With a classifier that supports choice questions, each `Agent` call whose
definition does not pin a model and which omits the call's `model` classifies the child task into the `low`,
`medium`, `high`, or `xhigh` tier. Model precedence is definition, then
the call's `model`, then classifier tier, then the parent. Thinking precedence
is unchanged. A failed classification or unavailable classified tier falls back
to the parent; an unavailable tier is logged as a warning.

Classifier state contains the current prompt, image count, up to 24 recent
model-visible conversation items including summaries (at most 1,200 UTF-8
bytes per excerpt, under the shared total evidence budget), the `explore` descriptor, and direct-child
statuses for routing; and the child prompt, description, and type for tier
selection. The same `classify` contract supports the shared bool discovery contribution
and the separate launch-time choice tier selection. Hosts may send that state to the selected
classifier provider's configured endpoint;
credentials remain host-owned and are never persisted in session records.

Decisions are logged at debug level through `AgentRuntime.logger` under the
`subagent-routing` and `subagent-model` components; failures are logged at warn.
Records include probabilities or choices and classifier metadata but omit the
request and conversation. Local TUI records are written to
`storage('agent')/logs/felan.jsonl`.

Ambient Pi agent and extension discovery is outside this package and remains
disabled by Felan applications.

## Installation and composition

Load the default extension with a provider for `SESSIONS_SERVICE`. Agent
catalogs are read through `AgentRuntime` from explicit user and workspace
`.agents/agents` and `.felan/agents` directories. Workspace definitions override
user definitions, which override the bundled `general`, `explore`, and
`reviewer` definitions.

The extension uses a compatible `@felan-ai/agent-core` peer and TypeBox. A
local TUI may offer a navigator, while other clients can read and control the
same child executions through the generic session protocol.

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
- [Efficient execution and savings](../../docs/concepts/efficient-execution.md)
