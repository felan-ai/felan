# @felan-ai/ext-prompt-history

Prompt-history search through generic UI, with an optional native TUI picker.

The default extension registers `/prompt-history`, `Ctrl+R`, and `Cmd+R`. It opens
with live current-session prompts and provides explicit query and scope controls
for session, current-project, and all-project history. Search remains fuzzy and
incremental, with newest-first deduplication and at most 50 results. Selecting a
result opens its full text; it never inserts, submits, or runs a prompt.

The optional native picker renders inline by default with two full-width horizontal separators. Set
`extensionConfig.promptHistory.displayMode` to `overlay` for a centered popup.
Overlay mode uses a complete four-edge frame.
Its editor insertion and TUI-only behavior remain available through the named
factory. Display mode does not affect the default generic UI.

## Composition

The default root requires the shared history-only Sessions service and uses the always-present `pi.ui`
API for presentation:

```ts
import extension from '@felan-ai/ext-prompt-history';
import { SESSIONS_HISTORY_SERVICE } from '@felan-ai/agent-core';

services.set(SESSIONS_HISTORY_SERVICE, sessionHistory);
```

Current-session searches extract prompts from the live session manager. Project
and global searches use only provider-visible sessions, pin each complete journal
to its revision and branch, and retain issued references internally. Duplicate
entries, invalid cursors, revision drift, and oversized histories fail explicitly.
Unavailable reads produce incomplete search results rather than an empty complete
success. The legacy feature-service exports remain available for callers, but the
default root neither declares nor consumes them.

The generic `view` exposes validated query/scope fields, result detail actions,
and scan progress. It requires no presenter hint, `hasUI`, or client-mode decision.
Project/global scans preserve batches of four sessions. Stopping a search or
changing its query prevents further batches and discards obsolete results after
in-flight reads finish. Opening returns after initial publication rather than
holding the command open while the user browses. Closing and shutdown abort and
join outstanding reads and UI work before closing the handles.

Queries are bounded to 4,096 UTF-8 bytes. Result previews are bounded to 512 bytes;
project/session labels use 128-byte previews. A clipped prompt preview is marked.
Selected prompts are not truncated: the existing 64 MiB display limit is enforced,
and full text is paged into encoded-byte-bounded 24 KiB chunks. Text is escaped for
literal Markdown display. Oversized selections fail explicitly instead of silently
losing text. Element identity, revision, action target, and field values are checked
before use. No generic action inserts text into an editor or executes a prompt.

The named factory remains available for direct composition, including its local
TUI fallback:

```ts
import { createPromptHistoryExtension } from '@felan-ai/ext-prompt-history';

const extension = createPromptHistoryExtension(host);
```

This native picker preserves scope cycling, inline/overlay presentation, and
replacement of the local editor with the selected prompt. Existing named factories
and public exports are unchanged. Configuration metadata remains available.

The package does not access the filesystem, network, credentials, or ambient Pi
configuration directly. Historical prompts can contain private source, paths,
commands, or credentials supplied in earlier user messages. Hosts should keep
session discovery local, bounded, and explicit about which projects are
visible.

Configured hosts load the package through their extension list. Historical
access comes from the session-scoped provider, not from a client-local store.

## Development

```sh
pnpm --filter @felan-ai/ext-prompt-history build
pnpm --filter @felan-ai/ext-prompt-history type-check
pnpm --filter @felan-ai/ext-prompt-history test
```

## Attribution

This package adapts the MIT-licensed `pi-prompt-history` implementation. See
[NOTICE](NOTICE) and [LICENSE](LICENSE).
