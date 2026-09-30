# Classifier decisions and response latency

The local host selects an authenticated classifier from Pi's catalog using
global `felanClassifier.model` (`auto` by default) and injects the optional
provider-neutral capability. Pi resolves credentials from the host's auth
store, provider configuration, and environment. Features own their
individual decisions; they do not run as one classifier pass. This matters for
the time between submitting a request and receiving the first model response.

## Before the first model response

| Decision | When it runs | When it is skipped or fails |
| --- | --- | --- |
| Prewalk entry | An eligible idle root-session `input` starts classification; `before_agent_start` waits for the result before supplying entry guidance. | Ineligible turns (including unavailable entry or mutation tools and denied entry) skip it. Failure adds no entry guidance. |
| Subagent discovery | An eligible root-session `input` starts classification; `before_agent_start` waits before adding discovery guidance. | Child sessions, one-shot print/JSON modes, and repositories with fewer than 20 files skip it. Failure adds no routing guidance. |
| Dynamic thinking | For a supported model, an eligible `input` starts classification; `before_agent_start` applies the result if the prompt and model still match. | Manual thinking overrides, unsupported models, and unavailable or uncertain decisions retain the current effort. Tool continuations are not classified again. |

In a root Agent Core session using its managed Pi-backed classifier, eligible calls start on `input` and share a **2-second
total preflight deadline**, not a separate wait for each decision. A direct
agent start without an `input` begins that budget at its first classification.
Pi awaits `before_agent_start` handlers sequentially, but a call still pending
at its handler can use only the *remaining* budget. Late answers are ignored;
Prewalk and subagent routing add no optional guidance, and dynamic thinking
keeps the current level. The persistent system prompt and explicit tools remain
available. Custom classifier implementations without the managed preflight retain
their own timing.
The model's own first-token latency comes after this gate.

The bridge passes a 20-second timeout **per classifier request** to Pi and
disables automatic transport retries, preserving the prior request behavior.
This timeout applies to calls outside the initial preflight too. Debug logs under
`classifier-preflight` record decision names, outcomes, decision elapsed time,
and time from preflight start to the first `turn_start`, without request text.
`turn_start` is not a first-token timestamp. The shared deadline limits
classifier waiting, not model generation, compaction, or other extension work;
it is not an end-to-end
first-response bound. No live latency improvement or first-response percentile
has been measured for this change.

## Other decision points

The same `classify` operation handles choice, boolean-probability, and score
questions. Model selection happens when the local root runtime is constructed;
settings changes apply to the next new root session/restart. Children inherit
the root classifier and memory receives the effective runtime capability.
An unavailable explicit model warns and uses Auto; no available model retains
normal feature fallbacks. See [classifier configuration](../user-guide/configuration.md#classifier-model).

- `Agent` model-tier selection runs when an unpinned child is launched, not as
  part of the initial pre-model gate.
- Prewalk exploration depth runs on entry; its implementation profile runs at
  handoff, and its completion decision runs when the implementation is ready
  to settle. These can delay their own phase, but not an ordinary initial turn.
- Session-compaction classification runs only at a compaction boundary. If a
  turn needs compaction before its model request, it can delay that turn's first
  response too; it is not a per-turn preflight. Local-memory classification
  belongs to its separate background memory workflow.

If first-response latency becomes a concern, measure input-to-first-token
latency (including p50/p95) and per-decision elapsed time on representative
eligible turns, alongside correctness and total task cost. Compare equivalent
classifier-enabled and disabled runs before changing hook timing or claiming a
net improvement. See [configuration](../user-guide/configuration.md#classifier-guided-subagents),
[subagents and Prewalk](../user-guide/agents-tasks-and-prewalk.md), and
[dynamic-thinking estimates](../benchmarks/dynamic-thinking-effort.md) for
feature-specific behavior and savings limitations.
