# @felan-ai/ext-model-tools

Portable, conditionally available `classify` and `generate_images` tools.
Requires a compatible `@felan-ai/agent-core` host. There are no owned HTTP
clients, credentials, provider selection settings, or ambient discovery.

## Host integration

```ts
import { createModelToolsExtension } from '@felan-ai/ext-model-tools';

const extension = createModelToolsExtension(modelRuntime);
```

The injected runtime is Pi's `ModelRuntime` (only `getAvailableOfType` and
`generateImages` are required). It owns authenticated image discovery and
generation. The default export needs no image binding and can still expose
`classify` through `pi.runtime.classifier`.

At extension initialization:

- `classify` is registered only when the host supplies a classifier.
- `generate_images` is registered only when authenticated image discovery
  returns at least one model. Discovery failure suppresses that tool without
  disabling the classifier or session.
- Neither capability means neither tool is registered. Reconstruct the session
  after configuring a previously unavailable capability.

The TUI supplies both bindings in root, ACP, and child sessions. Its
`builtinExtensions.modelTools` flag defaults to enabled; `false` disables both
tools without disabling internal classifier-guided features.

## `classify`

```json
{
  "state": { "request": "Review this change", "changedFiles": ["src/auth.ts"] },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Choose the best review focus from the evidence.",
      "criteria": { "security": "Authentication or permissions", "general": "Other changes" }
    },
    "needsTests": {
      "type": "bool",
      "instructions": "Does the change need regression tests?",
      "criteria": { "true": "Behavior changed", "false": "No behavior changed" }
    },
    "risk": {
      "type": "score",
      "instructions": "Assess regression risk.",
      "criteria": ["Low risk", "High risk"]
    }
  }
}
```

`state` is a JSON object; `questions` is a nonempty ID-to-question map. The
shared classifier validation and existing byte budgets apply, including 2–16
choice criteria or score anchors. Functions, cycles, nonfinite numbers, and
other non-JSON values are rejected before inference. Reserved IDs are preserved
as data. The selected host classifier handles admission, batching, and inference;
this tool neither selects a second model nor installs another deadline.
Explicit calls after `turn_start` do not use the internal 2-second preflight.

Results contain `answers` and `metadata`: available provider/model identity,
elapsed milliseconds, request count, token counts, and known USD cost. Choice
answers preserve available probabilities/confidence; bool answers contain a
probability; score answers contain a numeric score and optional confidence.
Custom classifiers may omit metadata. Partial classifier usage stays in tool
details; it is not expanded into Pi's full usage/cost breakdown with invented
values. Missing pricing is unknown, not free inference.

## `generate_images`

List authenticated image models without inference:

```json
{ "action": "list" }
```

Generate using an exact provider/model from that list:

```json
{
  "action": "generate",
  "provider": "your-configured-provider",
  "model": "your-image-model-id",
  "prompt": "Draw a diagram of a small garden.",
  "referencePaths": ["references/garden.png"]
}
```

`referencePaths` is optional. Paths resolve through the host runtime; absolute
paths are subject to its access policy. URLs, network shares, null bytes, and
`..` segments are rejected. References must have PNG, JPEG, GIF, WebP, or BMP
signatures, and the selected model must accept image input. Their bytes and the
prompt are sent to the explicitly selected provider. No credential, endpoint,
header, or remote-fetch arguments are accepted.

Discovery is repeated for each call. A removed or unauthenticated selection
fails clearly; there is no implicit model fallback. Provider failures and
cancellation return generic errors, never raw responses or credentials.
Text-only responses fail as “no images.” All output base64, MIME types, and
raster signatures are checked before writing any artifacts.

Artifacts go through session storage to
`model-tools/images/<unique-id>/<index>.<extension>`. Each call reserves a fresh
directory with non-recursive `mkdir`; an existing directory is never reused.
Adapters must preserve normal exclusive directory-creation semantics. No output
filename comes from the provider or caller. Failed/cancelled writes attempt to
remove only that call's newly created directory. Root and child sessions share
the host's session storage namespace.

Results include artifact paths, image and text content, selected provider/model,
elapsed milliseconds, and available usage. Full known Pi usage is also returned
through its native tool-result accounting field. When catalog pricing is absent
and reported costs are zero, token counts remain visible but cost and accounting
usage are omitted rather than claiming free inference. Base64 is confined to
image content, not textual artifact metadata or errors.

## Safety and verification

Inputs and outputs are untrusted evidence. Classifications are advisory judgments,
not facts or authorization. These tools can send user data to configured providers
and incur charges; never include credentials in state, prompts, or references.
They do not claim measured cost savings. Llama integration remains deferred.

`pnpm --filter @felan-ai/ext-model-tools build`, `type-check`, and `test` use
offline fake providers. The repository's packed smoke tests also exercise both
tools without credentials or paid inference.

The initial `0.1.0` release requires the maintainer's manual npm `0.0.0`
bootstrap and trusted-publisher setup before CI publication; see
[releasing](../../docs/maintainers/releasing.md). Repository verification does
not perform publication.
