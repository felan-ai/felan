# @felan-ai/ext-fusion

Runs the same explicit prompt against 2–8 authenticated, session-allowed chat
models in parallel, automatically compares their answers, and lets the user
review each answer before explicitly requesting a synthesis. It is provider
neutral and uses the configured Core Models service; OpenRouter models work
through their normal configured provider. It does not call OpenRouter's beta
Fusion server tool.

## Configuration and model selection

The default entry uses `pi.ui` forms, model-list views, progress and paged
review documents. It does not require a TUI, client-specific hint or injected
Fusion host. `/fusion-models` searches names and `provider/model` references,
pages through the catalogue, toggles participants and selects the comparison
model. Saving is explicit; cancelling leaves the previous lineup unchanged.

Configured `extensionConfig.fusion` values provide the initial lineup. Picker
choices are saved in the current session branch as `felan.fusion-lineup.v1`
and restored when reopening commands or reloading the extension. Saving also
awaits `pi.updateConfig({ participants, fusionModel })` to persist global
settings through the host-owned writer. If that writer is unavailable or
rejects the update, the session copy is retained, an explicit error is shown,
and the picker remains open for retry or cancellation. No global save is
silently assumed.

```json
{
  "extensionConfig": {
    "fusion": {
      "participants": ["openrouter/anthropic/claude-sonnet-4", "openai/gpt-5"],
      "fusionModel": "openrouter/anthropic/claude-sonnet-4",
      "concurrency": 4,
      "timeoutSeconds": 120,
      "maxOutputChars": 12000,
      "thinking": "off"
    }
  }
}
```

`participants` defaults to `[]`; a run never silently chooses models. Configure
2–8 distinct `provider/model-id` references. The picker displays only
authenticated models in the active session's allowed scope. The fusion model
must also be authenticated and in that scope. Nested IDs such as
`openrouter/anthropic/claude-sonnet-4` are supported.

## Commands and review

- `/fusion <prompt>` asks every participant the same prompt in a fresh,
  tool-free model request, then asks the selected fusion model for a comparison
  of agreements, disagreements, unique contributions, and uncertainty.
- `/fusion` reopens the latest unfinished review on the active session branch.
  After synthesis, it asks for a new prompt and starts a new run.
- `/fusion-models` searches and updates the participant and comparison model
  lineup; canceling leaves the saved lineup unchanged.
- Review full originals and comparison through document paging. Synthesis is
  offered only after comparison succeeds, with optional instructions and an
  explicit available `provider/model` override. Separate actions retry failed
  participants, comparison or synthesis. Closing/reopening does not repeat
  requests. A separate progress element can cancel an in-flight stage even
  while its review action is awaiting completion.

With N participants, comparison uses N+1 requests. Choosing Fuse makes one
additional model request; retries make the requests they explicitly repeat.
The confirmation form discloses this count before each new comparison run.
Review documents show provider-reported usage and estimated cost when supplied,
plus latency;
these estimates are not provider invoices and missing pricing is not free usage.

Fusion sends only the `/fusion` prompt and bounded source answers—not the
session transcript, project files, or the active model's tools. The prompt and
bounded answers/comparison are saved as a custom entry in the current session
branch for review and recovery. Model outputs and the comparison are untrusted
evidence; agreement is not verification. The fused result is added to the
transcript only after explicit user action. Provider cancellation is best
effort and a request already received by a provider may still incur charges.

The comparison stage never writes files or automatically fuses. Execution
remains with the extension and configured Models provider, not the UI client.
Cancellation and shutdown join outstanding provider calls, including providers
that return after their abort signal fires. Late results cannot publish a
successful review or transcript message.

The catalogue limit is 10000 models, with 40 visible rows per page. References
must fit 300 UTF-8 bytes. Prompts are limited to 20000 characters; form input
also obeys the protocol's 32-KiB field limit. Review documents use 24000-byte
pages; the existing 240000-byte saved-review limit remains. Unsupported data
is rejected rather than silently omitted. Model-output bounding still follows
`maxOutputChars` and is explicitly disclosed.

## Host API

The package root's default export is the service-backed execution entry. It
declares optional Core `MODELS_SERVICE` (`felan.models@1`). Without a provider,
both commands remain registered but warn that Models is unavailable; no
inference runs. UI unavailability or a cancelled/deferred confirmation does
not approve a request.
The root entry retains `FUSION_CONFIG` metadata for configuration discovery.

```ts
import { MODELS_SERVICE } from '@felan-ai/agent-core';

services.set(MODELS_SERVICE, modelsService);
```

Inference uses `ModelsService.getAvailable` and `completeSimple`, with fresh
availability checks before dispatch. There is no ambient credential discovery
or direct HTTP client. The pure `runFusion`, `compareFusionAnswers` and
`synthesizeFusion` APIs remain unchanged.

Hosts supply `CreateAgentCoreSessionOptions.updateExtensionConfig(packageName,
patch)` for global settings persistence. Core binds the package identity and
validates writable declared fields; the host owns policy and durable storage.
The extension's resolved `pi.config` snapshot changes on reload, not during
the persistence callback.

The named `createFusionExtension(host?)` factory accepts an explicit `FusionHost`.
Configured hosts should use the service-backed default for generic UI across
clients. The package exports no TUI entrypoint.

```sh
pnpm --filter @felan-ai/ext-fusion build
pnpm --filter @felan-ai/ext-fusion type-check
pnpm --filter @felan-ai/ext-fusion test
```

The new npm package requires a maintainer's manual `0.0.0` bootstrap and
trusted-publisher setup before its intended CI release; see
[`docs/maintainers/releasing.md`](../../docs/maintainers/releasing.md). Local
verification does not publish the package.
