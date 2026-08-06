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
- string options or `{ title, description }` options
- searchable single-select, multi-select, and freeform answers
- optional comments on structured selections
- overlay and inline display modes
- configurable overlay and comment shortcuts
- prompt timeout

Top-level question fields provide defaults to entries in `questions[]`. Questions receive
stable `q1` through `q4` IDs in normalized requests and structured result details.

## Local adapter

`createTuiAskUserHost()` uses the `ExtensionContext` supplied to each tool execution. TUI
mode provides searchable option descriptions, split-pane previews on wide terminals,
multi-select, freeform and comment editors, wizard navigation and review, overlay hiding,
abort handling, and timeout handling. RPC mode uses Pi's dialog methods. Print and JSON
modes return an unavailable cancellation outcome.

Environment defaults remain available for local use:

- `PI_ASK_USER_DISPLAY_MODE`
- `PI_ASK_USER_OVERLAY_TOGGLE_KEY`
- `PI_ASK_USER_COMMENT_TOGGLE_KEY`

Per-call values take precedence. `off`, `none`, `disabled`, or `null` disables a shortcut.

## Attribution

The local interface is adapted from `pi-ask-user` by Enzo Lucchesi. See `NOTICE` and
`LICENSE` for source and license details.
