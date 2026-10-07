# Classifier decisions and response latency

The local host selects an authenticated classifier from Pi's catalog using
`felanClassifier.model` (`auto` by default), owns credentials and settings, and
injects the optional provider-neutral capability. Agent Core composes eligible
root entry decisions into one registered turn-classification pass. Extensions
own eligibility, criteria, thresholds, guidance and fallback behaviour.

## Before the first model response

| Contribution | Decision | Skips or fallback |
| --- | --- | --- |
| Prewalk | Whether to recommend entry, plus a conditional capable planning model/effort profile. | Child sessions, unavailable tools and denied model entry skip recommendations. Failure adds no entry guidance; approved entry still requires a capable static planning profile. |
| Subagent discovery | Whether broad, unknown discovery would replace substantial parent reading. | Child/one-shot sessions, small repositories and already-covered work do not receive optional discovery guidance. |
| Regular thinking | Supported reasoning effort if the request stays outside an active workflow. | Explicit overrides, owned phase selections, unsupported models and unavailable/uncertain answers retain the current level. |

Registration happens during extension initialization. On `input`, Core collects
one bounded, sanitized session snapshot and prepares eligible contributions in
parallel. It namespaces question IDs and additional state, calls the classifier
once, validates the complete answer set, and lets feature handlers consume their
own answers in `before_agent_start`. Independent questions cannot see one
another's answers: conditional regular-path and Prewalk questions state their
premises, and code consumes the applicable profile. Entry remains guidance;
`enter_prewalk` approval is not bypassed.

A root pass has the existing **2-second shared deadline**, including preparation
and inference, for Pi-backed and custom classifier capabilities. A direct agent
start uses the same pass; prompt expansion supersedes the earlier snapshot and
cancels its request. Invalid or failed preparation is isolated before inference;
a stalled preparation can exhaust the shared budget. Failed, incomplete or late
responses fall back without optional guidance. Tool continuations do not trigger
another pass. Manual selections invalidate pending results; workflow-owned
promotion retains other consumers' applicable answers. Sessions, reloads and
shutdowns do not share pending requests.

One logical call is normally one provider request, but existing byte-budget
batching can require more. The Pi bridge retains its 20-second per-request
transport timeout and disables retries; the root coordinator can cancel earlier.
Later workflow calls and explicit `classify` tools are outside the entry budget.
The deadline is not an end-to-end first-response bound.

Debug logs under `turn-classification` contain producer IDs, sanitized validated
answers and shared metadata, not request text. `classifier-preflight` records
outcomes and elapsed time. These are not first-token observations; performance
requires actual streaming evidence. Shared usage must be counted once, not once
per consumer. No live speedup or net savings have been measured.

## Phase ownership

Prewalk activates a capable same-provider high-effort planning profile after
approval and before planning inference. During its planning and implementation
phases, regular dynamic thinking does not compete with that selection. Handoff
honors configured `targetModel`/`targetThinking`; stronger classifier advice is
reported, not automatically applied. Automated promotion, handoff and restoration
are session-local and do not pin ordinary effort as a manual override. Manual
changes remain authoritative; releasing a workflow restores ordinary routing.

## Other decision points

The classifier contract still supports choice, boolean-probability and score
questions. Host selection is resolved for each new root runtime; children and
memory inherit the effective capability. An unavailable explicit classifier warns
and uses Auto; no available classifier retains feature fallbacks.

- Unpinned `Agent` model-tier selection runs at launch with the actual assignment.
- Prewalk exploration depth runs on entry; implementation advice runs with the
  approved plan at handoff; completion runs when implementation is ready to settle.
- Compaction runs at a compaction boundary and may delay a request needing it.
- Memory classification remains part of its separate background workflow.

See [configuration](../user-guide/configuration.md#classifier-guided-subagents),
[Prewalk](../user-guide/agents-tasks-and-prewalk.md),
[shared-classification benchmarks](../benchmarks/turn-classification.md) and
[dynamic-thinking estimates](../benchmarks/dynamic-thinking-effort.md).
