# Turn classification benchmark assets

Provider-backed trials were run on 2026-10-07: 65 of 96 passed, with unresolved
discovery and implementation failures. No savings claim is valid until those
failures are diagnosed and quality gates pass. See
[`turn-classification-failures.md`](../../../docs/benchmarks/turn-classification-failures.md).
The root methodology lives in `docs/benchmarks/turn-classification.md`.

From `evals/`:

```sh
pnpm test
pnpm run list --config turn-classification-evals.yaml
```

Listing uses the recorded source image but does not prove that image is current.
Before a future **explicitly authorized** provider run, rebuild the source image
with `pnpm build:source`. Do not reuse an image built before shared preflight was
implemented. Then, with authenticated official Codex and `TYPESAFE_API_KEY`:

```sh
pnpm run run --config turn-classification-evals.yaml --benchmark turn-classification --concurrency 1 --cleanup
pnpm run run --config turn-classification-evals.yaml --benchmark turn-classification-transport --concurrency 1 --cleanup
```

The corresponding Luna-start benchmarks are `turn-classification-luna` and
`turn-classification-luna-transport`. All use three trials. Require every
business/metadata gate to pass before comparing usage or latency. Missing USD
cost prevents a net-cost savings conclusion.

## Controlled comparison

The six configurations cover shared, classifier-disabled, and separated
transport with each of two starting models. Both official
`openai-codex/gpt-6.1-sol` and `openai-codex/gpt-6-luna` are scoped in every
session. Starting effort is saved default-settings `high`, not a CLI/manual
selection. Real Codex, Tasks, Prewalk and Subagents extensions are identical;
entry approval is `allow`, plan review is `skip`, target model is `low`, target
effort is `medium`, and planner restoration is enabled in every arm.

The versioned commerce fixture has 25 project files: routine tax rounding,
broad read-only workflow discovery, planned order quotation implementation,
and manual thinking override after `/prewalk`, followed by a recovery turn.
The network-free verifier checks business results and protects unrelated
baseline files. Shared and separated implementation cases require root planning
and implementation inference, not just phase labels or selection recommendations.
Disabled controls need not enter Prewalk; any observed phase inference still
must satisfy its profile requirements. Recovery requires the manual `low`
selection to survive.

Every observed inference must use the pinned official Codex model scope. The
fixture explicitly requires Sol at `high` or `xhigh` for planning and Luna at
`medium` for the configured `low` implementation target. Grading pins the fixture
policy rather than trusting altered result configuration or guessing capability
from model names. An offline parity test keeps the isolated verifier requirements
aligned with the versioned fixture policy and profiles.

Shared and separated arms explicitly inject `createPiClassifier` using
`getAvailableOfType('classifier', 'typesafe')` and pinned `jev-latest`. Disabled
injects no classifier and never queries classifier availability. The eval-only
transport groups namespaced question IDs by their prefix, preserving the full
shared state, exact IDs and question definitions, calls the native classifier
per group concurrently, validates each result and the merged result, and
merges metadata without turning missing values into zero. Unnamespaced later
handoff/completion requests pass through as one call. No legacy production
flags or historical policy variants are involved. Separate runs can diverge
after different answers; request digests expose actual evidence identity rather
than claiming later conversational states remain equal.

## Result contract (schemaVersion 1)

`.eval-output/result.json` and sanitized stdout contain:

- `source`: image ID, source revision/dirty marker, image digest and packed
  package versions/SHA-256 hashes; `fixture`: name, version, file count/digest;
  `config`, `configDigest`, `promptDigest`.
- `classifications`: logical call count, question IDs/count, state/question
  digests, native invocation count, validated answers, status and metadata.
- `classifierRequests`: actual native `ModelRuntime.classify` dispatches,
  including failures and batching, question counts, duration, tokens and cost.
  `counts.classifierProviderRequests` is **not** the registry invocation count.
- `usage.classifier`, `usage.agent` (root plus the real host's descendant
  usage), and `usage.combined`; unknown tokens/cost are `null`. Classifier
  zero-request usage is zero; Codex subscription USD cost is unknown, not zero.
- `timing.elapsedMs`, `timing.inputToFirstOutputMs` (first nonempty assistant
  text delta after input, never `turn_start`; `null` if unavailable), `phases`,
  `selections`, and `manual` outcomes. Inference rows are observed at the context
  hook and include provider, model, effort and the latest Prewalk custom-message
  phase in that inference's context (`null` outside Prewalk). Replayed historical
  phase labels do not count as additional planning or implementation inference.

Classifier dispatches have retries disabled by the native classifier. Root
assistant-message counts are separately labelled and are not advertised as
agent wire-level request counts. The public `createLocalFelanRuntime` SDK owns `LocalSubagentHost`, Core
composition and native completion delivery; the custom `HostAgentRuntime`
explicitly injects the arm classifier (including `undefined` for disabled),
without setting `options.thinkingLevel` that would bypass dynamic thinking; the driver retains the RPC root until host work and
resumed parent inference settle, then shuts down the host before disposal.
Private child transcripts, task storage and run-owned auth/config copies are
removed; no raw prompts, outputs, credentials or provider errors enter result
JSON. Every run keeps `.eval-output/diagnostics.json` and
`.eval-output/verifier-diagnostics.json` with allowlisted lifecycle, phase and
check details. `--cleanup` removes adapter cleanup paths; run-owned config is
always deleted, including with `--no-cleanup`. The persistent OAuth login
profile is not deleted. Use harness cleanup for any remaining auth mounts.

The harness runtime was the local linked checkout `harness-evals@0.2.17` during
these runs; `evals/package.json` and `pnpm-lock.yaml` pin published `0.2.16`.
Reproduce through the locked package after resolving that dependency mismatch.

Offline tests use fake services and never import `run.mjs` or provider packages.
They prove wiring, transport parity, dispatch accounting, unknown-cost handling,
asynchronous waiting, and verifier sensitivity—not live inference, classifier
quality, subscription prices, or actual delegation savings. End-to-end child
usage and completion delivery remain pending authorized validation.
