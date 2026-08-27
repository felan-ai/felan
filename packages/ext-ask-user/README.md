# @felan-ai/ext-ask-user

Portable Felan `ask_user` extension with an explicit delivery host and a rich local Pi-TUI adapter.

## Usage

```ts
import { createAskUserExtension } from '@felan-ai/ext-ask-user';
import { createTuiAskUserHost } from '@felan-ai/ext-ask-user/tui';

const extension = createAskUserExtension(createTuiAskUserHost());
```

Cloud or remote hosts implement `AskUserHost`. The core extension owns the tool schema,
normalization, response validation, sequential tool execution, progress details, and
agent-facing result text. The host owns presentation and delivery. Host outcomes are
`answered`, `cancelled`, or `deferred`; deferred outcomes carry a required interaction
ID so a remote host can correlate the next user turn. Each host call also receives the
Pi tool-call ID and session ID.

## Tool input

`ask_user` supports:

- one question or a 1-4 question wizard
- provider-safe `{ title, description? }` option objects in the tool schema, with
  runtime compatibility for legacy string options and common proxy aliases
- searchable single-select, multi-select, and freeform answers
- optional comments on structured selections
- overlay and inline display modes
- automatic split-pane or always-list single-select layouts
- configurable overlay and comment shortcuts
- prompt timeout

Top-level question fields provide defaults to entries in `questions[]`. Questions receive
stable `q1` through `q4` IDs in normalized requests and structured result details.

## Local adapter

`createTuiAskUserHost()` uses the `ExtensionContext` supplied to each tool execution. TUI
mode provides searchable option descriptions, split-pane previews on wide terminals,
multi-select, freeform and comment editors, wizard navigation and review, overlay hiding,
abort handling, and timeout handling. Long context starts collapsed so choices remain
visible; press `ctrl+e` to expand or collapse it. Multi-select viewports are bounded by
rendered rows and keep the active choice visible. RPC mode uses Pi's dialog methods.
Print and JSON modes return an unavailable cancellation outcome.

For compatibility with older transcripts and schema-mangling proxies, runtime option
normalization also accepts string, number, and boolean entries and the object keys
`label`, `text`, `value`, `name`, and `option`. Unusable entries return a validation
error instead of silently falling back to a freeform prompt.

Local defaults are configured declaratively under `extensionConfig.askUser` in
`$FELAN_AGENT_DIR/settings.json`, through `/settings`, or through generated CLI options:

```json
{
  "extensionConfig": {
    "askUser": {
      "displayMode": "inline",
      "singleSelectLayout": "auto",
      "overlayToggleKey": "alt+o",
      "commentToggleKey": "ctrl+g"
    }
  }
}
```

The defaults are `inline`, `auto`, `alt+o`, and `ctrl+g`, respectively. Use `off`,
`none`, `disabled`, or an empty value to disable either shortcut. Per-call tool values
take precedence over these settings. Generated CLI names are
`--ask-user-display-mode`, `--ask-user-single-select-layout`,
`--ask-user-overlay-toggle-key`, and `--ask-user-comment-toggle-key`.

## Attribution

The local interface is adapted from `pi-ask-user` by Enzo Lucchesi. See `NOTICE` and
`LICENSE` for source and license details.

## Package boundary and requirements

The portable package owns the tool schema, normalization, validation, progress,
and result text. A host owns presentation and delivery through `AskUserHost`;
the local TUI adapter is optional. The package requires a compatible
`@felan-ai/agent-core` peer, TypeBox, and Pi-TUI.

## Development

Source: `packages/ext-ask-user` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-ask-user build
pnpm --filter @felan-ai/ext-ask-user type-check
pnpm --filter @felan-ai/ext-ask-user test
```

## Related documentation

- [Commands and shortcuts](../../docs/user-guide/commands-and-shortcuts.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)
- [Architecture](../../docs/concepts/architecture.md)
