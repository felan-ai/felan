# @felan-ai/ext-prompt-history

TUI-only prompt-history picker for Felan hosts.

The extension registers `Ctrl+R` and `Cmd+R`. It opens with prompts from the
current session, then cycles through current-project and all-project history
with `Ctrl+R`, `Cmd+R`, or `Ctrl+S`. Search is fuzzy and incremental, duplicate
prompt text is suppressed, and selecting a result replaces the editor text.

The picker renders inline by default with two full-width horizontal separators. Set
`extensionConfig.promptHistory.displayMode` to `overlay` for a centered popup.
Overlay mode uses a complete four-edge frame.
It does not open in print, JSON, or RPC modes.

## Composition

The package owns the search workflow and TUI. A host owns session discovery and
read-only parsing through `PromptHistoryHost`:

```ts
import { createPromptHistoryExtension } from '@felan-ai/ext-prompt-history';

const extension = createPromptHistoryExtension(host);
```

The package does not access the filesystem, network, credentials, or ambient Pi
configuration directly. Historical prompts can contain private source, paths,
commands, or credentials supplied in earlier user messages. Hosts should keep
session discovery local, bounded, and explicit about which projects are
visible.

The local Felan TUI enables the extension as the `promptHistory` built-in. Set
`builtinExtensions.promptHistory` to `false` to disable it.

## Development

```sh
pnpm --filter @felan-ai/ext-prompt-history build
pnpm --filter @felan-ai/ext-prompt-history type-check
pnpm --filter @felan-ai/ext-prompt-history test
```

## Attribution

This package adapts the MIT-licensed `pi-prompt-history` implementation. See
[NOTICE](NOTICE) and [LICENSE](LICENSE).
