# @felan-ai/ext-fusion

Runs the same explicit prompt against 2–8 authenticated, session-allowed chat
models in parallel, automatically compares their answers, and lets the user
review each answer before explicitly requesting a synthesis. It is provider
neutral and uses the host's existing Pi model registry; OpenRouter models work
through their normal configured provider. It does not call OpenRouter's beta
Fusion server tool.

## Local setup

The local TUI enables Fusion by default and offers searchable `/fusion` model
setup on first use. Type to fuzzy-search names or `provider/model` references;
Enter toggles a participant, Tab switches to comparison-model selection,
Ctrl+S saves, and Esc cancels. A selected-model summary stays visible beside
the results, or below them in a narrow terminal. Run `/fusion-models` to edit
the lineup later without making requests or restarting. `/settings` also
exposes the underlying extension config. The `F` synthesis override uses the
same search picker without changing the saved lineup. Selected models are
stored under `extensionConfig.fusion` in `$FELAN_AGENT_DIR/settings.json`.
Disable the built-in with `builtinExtensions.fusion: false`.

```json
{
  "builtinExtensions": { "fusion": true },
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
2–8 distinct `provider/model-id` references. The local picker displays only
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
- Review the originals and comparison with arrow keys; scroll long answers.
  Press `f` to explicitly fuse with the selected fusion model, or `F` to add
  an instruction and choose another allowed model. `r` retries only failed
  participants; `c` retries only comparison. Close/reopen never repeats a
  request. Escape cancels active work.

With N participants, comparison uses N+1 requests. Choosing Fuse makes one
additional model request; retries make the requests they explicitly repeat.
The TUI discloses this count and asks before each comparison run. It shows
provider-reported usage, catalog-based estimated cost when known, and latency;
these estimates are not provider invoices and missing pricing is not free usage.

Fusion sends only the `/fusion` prompt and bounded source answers—not the
session transcript, project files, or the active model's tools. The prompt and
bounded answers/comparison are saved as a custom entry in the current session
branch for review and recovery. Model outputs and the comparison are untrusted
evidence; agreement is not verification. The fused result is added to the
transcript only after explicit user action. Provider cancellation is best
effort and a request already received by a provider may still incur charges.

The comparison stage never writes files or automatically fuses. The upstream
Pi `fusion-harness` `/fh-model` command uses sequential slot → model/provider →
thinking selectors. Felan follows Pi `/model`'s fuzzy-search interaction with
a persistent multi-model selection summary instead of copying that different
slot workflow. This is client-side parallel completion followed by synthesis,
distinct from the OpenRouter beta server tool and from coding-agent harnesses
that can modify the repository.

## Host API

Portable behavior is exported from `src/index.ts`. A host supplies
`FusionHost.configure`, `FusionHost.confirm`, and `FusionHost.review`; the
extension supplies authenticated model choices and review actions. Inference
uses `ExtensionCommandContext.modelRegistry` and Pi's provider adapters rather
than a new HTTP client or credential contract. The built-in local TUI provides
model selection, settings persistence, and the review panel.

```sh
pnpm --filter @felan-ai/ext-fusion build
pnpm --filter @felan-ai/ext-fusion type-check
pnpm --filter @felan-ai/ext-fusion test
```

The new npm package requires a maintainer's manual `0.0.0` bootstrap and
trusted-publisher setup before its intended CI release; see
[`docs/maintainers/releasing.md`](../../docs/maintainers/releasing.md). Local
verification does not publish the package.
