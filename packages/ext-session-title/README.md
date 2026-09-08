# @felan-ai/ext-session-title

Portable automatic session-name generation for Felan hosts.

The extension waits for the first user prompt, asks the host to generate a
bounded title, and persists it through `pi.setSessionName()`. It skips named,
resumed, forked, and previously used sessions. Generation is detached from the
main turn and cancelled during session shutdown. The host's `prepare()` method
decides which Pi modes are supported, including headless modes.

`formatSessionTerminalTitle()` returns a control-character-free terminal title
containing the session name alone, or the working-directory basename when the
session is unnamed. TUI hosts can use it for every terminal-title refresh.

Hosts provide `SessionTitleHost` so credentials, model access, billing, and
external persistence remain outside this package. `prepare()` can decline a
mode and can provide `preferredModel` when its model policy differs from the
current Pi model. The host must treat the prompt and generated title as
untrusted data.

```ts
import { createSessionTitleExtension } from '@felan-ai/ext-session-title';

const extension = createSessionTitleExtension({
  prepare: async ({ currentModel, prompt }) => {
    if (!currentModel) return undefined;
    return {
      prompt,
      provider: currentModel.provider,
      models: await modelRuntime.getAvailable(currentModel.provider),
    };
  },
  complete: ({ model, context, options }) => modelRuntime.completeSimple(model, context, options),
  reportError: (failure) => console.error('session title failed', failure.stage, failure.error),
  reportSkip: (skip) => console.debug('session title skipped', skip.reason),
});
```

The extension reports every skipped attempt through `reportSkip` and every
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
