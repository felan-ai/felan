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

Environment defaults remain available for local use:

- `PI_ASK_USER_DISPLAY_MODE`
- `PI_ASK_USER_SINGLE_SELECT_LAYOUT` (`auto` or `list`)
- `PI_ASK_USER_OVERLAY_TOGGLE_KEY`
- `PI_ASK_USER_COMMENT_TOGGLE_KEY`

Per-call values take precedence. Display-mode and single-select-layout environment values
are trimmed and case-normalized. `off`, `none`, `disabled`, or `null` disables a shortcut.

## Attribution

The local interface is adapted from `pi-ask-user` by Enzo Lucchesi. See `NOTICE` and
`LICENSE` for source and license details.
