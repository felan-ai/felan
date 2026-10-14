# @felan-ai/ext-ask-user

Portable Felan `ask_user` extension using generic UI forms. Optional native
rendering belongs to the client, not this package.

## Usage

```ts
import askUser from '@felan-ai/ext-ask-user';

const extension = askUser;
```

The default root uses the always-present `pi.ui.request` API. It declares no service
requirements. The host supplies generic form
delivery, answer eligibility, cancellation, and deferred delivery. The extension does
not inspect client kind or `hasUI`. The optional `ask-user.wizard` version `1`
hint selects optional client rendering without changing form fields or outcomes.

For an explicitly chosen host, the named factory remains available:

```ts
import { createAskUserExtension } from '@felan-ai/ext-ask-user';
const extension = createAskUserExtension(deliveryHost);
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
- single-select, multi-select, and freeform answers
- optional comments on structured selections
- optional local-adapter overlay/inline modes, single-select layouts, and shortcuts
- prompt timeout

Top-level question fields provide defaults to entries in `questions[]`. Questions receive
stable `q1` through `q4` IDs in normalized requests and structured result details.

## Generic form adapter

A single call produces one `form`, including all wizard questions. Questions,
headers, context, option titles, and descriptions appear without truncation. Display
Markdown is escaped so HTML, links, and formatting supplied as text remain literal;
control characters are displayed as escape sequences. Option labels are plain text.

Fields use stable question IDs (`q1`–`q4`) and suffixes `.mode`, `.selection`, `.text`,
and `.comment` where applicable. Choice values are `option1`, `option2`, and so on,
mapped back to the original option titles only after validation. When both choice
and freeform answers are available, an explicit answer type is required. Wizards
also offer an explicit skip type; at least one question must be answered. There are
no default answers. Inactive fields may be omitted; empty text and multi-select
fields are also allowed. Conflicting non-empty fields, missing answers, unknown
options, duplicate choices, excessive selections, and comments on freeform answers
are rejected.

Forms declare submit and cancel actions. Display modes,
layouts, and shortcuts do not alter generic form behavior. The tool's abort signal
and optional timeout are forwarded to `pi.ui.request`; deferred interaction IDs
are retained. Unsupported UI maps to an unavailable cancellation. Host drain and
restart map to abort cancellation with the original cause in the message.

The generic protocol imposes these limits, measured in UTF-8 bytes:

- At most 64 options per question; option labels must fit 1,024 bytes.
- At most 128 KiB of Markdown after escaping, and 256 KiB for the aggregate form.
- Written answers and comments each have a 32 KiB limit. All submitted values
  together must fit 64 KiB, and the form plus answer must fit 256 KiB.

Requests that exceed the form limits return an explicit tool error before delivery;
oversized answers are also rejected. Content and option lists are never shortened
to fit. These bounds apply to the generic adapter, not to custom named hosts.

## Client rendering

Felan's TUI renders the optional wizard hint. Inline
questions use two full-width horizontal separators; overlay questions use a complete
four-edge frame. TUI mode provides searchable option descriptions, split-pane previews
on wide terminals,
multi-select, freeform and comment editors, wizard navigation and review, overlay hiding,
abort handling, and timeout handling. Long context starts collapsed so choices remain
visible; press `ctrl+e` to expand or collapse it. Multi-select viewports are bounded by
rendered rows and keep the active choice visible. Other clients use the same generic
form; a client without interactive form support returns an unavailable outcome.

For compatibility with older transcripts and schema-mangling proxies, runtime option
normalization also accepts string, number, and boolean entries and the object keys
`label`, `text`, `value`, `name`, and `option`. Unusable entries return a validation
error instead of silently falling back to a freeform prompt.

Felan TUI defaults live under `presentation.askUser` in
`$FELAN_AGENT_DIR/tui/settings.json`, through `/settings`, or through TUI-only CLI options:

```json
{
  "presentation": {
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
`none`, `disabled`, or an empty value to disable either shortcut. Per-call tool hints remain optional and pass unchanged to named hosts. The generic
form adapter ignores them; Felan TUI uses its own preferences. Legacy
`extensionConfig.askUser` values are read only when a local preference is absent. Generated CLI names are
`--ask-user-display-mode`, `--ask-user-single-select-layout`,
`--ask-user-overlay-toggle-key`, and `--ask-user-comment-toggle-key`.

## Attribution

The local interface is adapted from `pi-ask-user` by Enzo Lucchesi. See `NOTICE` and
`LICENSE` for source and license details.

## Package boundary and requirements

The portable package owns the tool schema, normalization, validation, generic form
mapping, progress, and result text. Hosts own delivery through `pi.ui` or an explicit
`AskUserHost`. The package requires a compatible `@felan-ai/agent-core` peer,
Session Protocol and TypeBox. It exports no TUI entrypoint.

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
