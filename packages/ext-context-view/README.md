# @felan-ai/ext-context-view

Local TUI context-window usage inspection for Felan.

The extension registers `/context`. In the interactive TUI it renders a themed
report inline by default, with an estimated token breakdown for the system
prompt, built-in and extension tools, project context files, skills, memory,
conversation messages, other context, and free space. Root project instructions
are counted under Context Files, not the system prompt or conversation
messages. Set
`extensionConfig.contextView.displayMode` to `overlay` for a centered overlay.
In headless modes it emits the same report as a notification. The report
includes the current model and counts of tools, context files, and skills.

Values are estimates based on the assembled prompt and active session entries;
they are not provider billing measurements. The underlying runtime context
usage remains authoritative when available, including its unknown state after
compaction before the next model response.

The custom report is intentionally TUI-only and closes with `Esc`, `Enter`, or
`q`. Inline output uses two horizontal separators; overlay output uses a complete
four-edge frame. The Memory row separates the initial `summary.md`, `index.md`, and schema
context from identifiable recalls of files in the session memory projection.
The default local Felan host enables this extension as the `contextView`
built-in; set `builtinExtensions.contextView` to `false` to disable it.

## Composition

```ts
import contextViewExtension from '@felan-ai/ext-context-view';
```

The default export collects the report and retains the compact headless
notification. Interactive hosts now opt into the renderer explicitly:

```ts
import { createContextViewExtension } from '@felan-ai/ext-context-view';
import { createTuiContextViewHost } from '@felan-ai/ext-context-view/tui';

const extension = createContextViewExtension(createTuiContextViewHost());
```

The TUI subpath also exports `ContextUsageOverlay`. Moving that class and
removing implicit interactive rendering are breaking changes in 0.7.0, not a
patch release. Active views close and settle on
session shutdown.

The daemon/client adapter uses the validated `./view` contract. It sends only
report measurements, bounded display labels, and the eight detail rows already
shown by the overlay, with accurate total counts for `+N more`. It does not send
prompt text, memory documents, credentials, or runtime handles. The interaction
can only be closed; it cannot change the model or context. Unknown context
windows remain unknown, and the report remains an estimate, not a billing
measurement. Felan's local daemon/client composition uses this adapter;
Windows support for the local daemon remains deferred.

The package consumes the public Pi composition surface from
`@felan-ai/agent-core` and the pinned `@earendil-works/pi-tui` dependency. It
performs no filesystem, network, credential, or host-specific I/O.

## Development

```sh
pnpm --filter @felan-ai/ext-context-view build
pnpm --filter @felan-ai/ext-context-view type-check
pnpm --filter @felan-ai/ext-context-view test
```

## Attribution

This package adapts the MIT-licensed `pi-context` implementation. See
[NOTICE](NOTICE) and [LICENSE](LICENSE).
