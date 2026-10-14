# @felan-ai/ext-session-title

Portable automatic session-name generation for Felan hosts.

The extension waits for the first user prompt, uses the shared Models service
to generate a bounded title, and persists it through `pi.setSessionName()`. It skips named,
resumed, forked, and previously used sessions. Generation is detached from the
main turn and cancelled during session shutdown. The default entry supports new
root sessions across all client kinds, including headless modes, without UI or
host-specific eligibility checks.

`formatSessionTerminalTitle()` returns a control-character-free terminal title
containing the session name alone, or the working-directory basename when the
session is unnamed. TUI hosts can use it for every terminal-title refresh.

The package root's default export is the service-backed execution entry. It
declares optional Core `MODELS_SERVICE` (`felan.models@1`). Without it, only
automatic title generation is disabled, with a metadata-only debug diagnostic.
Discovery uses the current model's provider and the service's authenticated,
allowed scope. The extension never falls back to a different provider.
Completion passes only `{ provider, id }`; the service revalidates authorization
and scope at dispatch. No endpoint, credentials, or fabricated model URL is
exposed through the title contracts.

```ts
import { MODELS_SERVICE } from '@felan-ai/agent-core';

services.set(MODELS_SERVICE, modelsService);
```

The named `createSessionTitleExtension(host)` factory remains available for
explicit composition, custom preparation, persistence, and attempt limits.
Its model contracts use endpoint-free `TextModelInfo`.

```ts
import { createSessionTitleExtension } from '@felan-ai/ext-session-title';

const extension = createSessionTitleExtension({
  prepare: async ({ currentModel, prompt, signal }) => {
    if (!currentModel) return undefined;
    return {
      prompt,
      provider: currentModel.provider,
      models: await modelsService.getAvailable(currentModel.provider, { signal }),
    };
  },
  complete: ({ model, context, options }) => modelsService.completeSimple(
    { provider: model.provider, id: model.id }, context, options,
  ),
  reportError: (failure) => console.error('session title failed', failure.stage, failure.error),
  reportSkip: (skip) => console.debug('session title skipped', skip.reason),
});
```

The default adapter logs only metadata through `pi.runtime.logger`, including
actual provider-reported completion usage. It never logs prompt text, generated
titles, raw errors, or endpoint data. Usage is preserved from the response, not
estimated from the selected model's prices.

The named factory reports every skipped attempt through `reportSkip` and every
failed attempt through `reportError`, then retries transient failures on the
next prompt (up to 3 attempts per session by default). Pass
`{ maxAttempts: 1 }` for a single-attempt host policy. Hosts should persist
these signals somewhere durable: the TUI toast fallback is transient and
never reaches the session transcript.

The default policy limits the input to 4,000 characters, uses at most 64
output tokens, allows no retries or cache retention, and times out after 30
seconds. It selects a text-capable low-tier model for the host-selected
provider, preferring the session's current model when eligible. If no low-tier
model is available, it selects the cheapest text-capable model. Generated
titles are normalized to 80 characters.

## Development

```sh
pnpm --filter @felan-ai/ext-session-title build
pnpm --filter @felan-ai/ext-session-title type-check
pnpm --filter @felan-ai/ext-session-title test
```

The package is independent of the local TUI, Supabase, and cloud runtime.
