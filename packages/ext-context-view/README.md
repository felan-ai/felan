# @felan-ai/ext-context-view

Portable context-window usage inspection for Felan.

The extension registers `/context`. Its package root presents a generic UI
document through `pi.ui` in every mode, with an estimated token breakdown for the system
prompt, built-in and extension tools, project context files, skills, memory,
conversation messages, other context, and free space. Root project instructions
are counted under Context Files, not the system prompt or conversation
messages. The report
includes the current model and counts of tools, context files, and skills.

Values are estimates based on the assembled prompt and active session entries;
they are not provider billing measurements. The underlying runtime context
usage remains authoritative when available, including its unknown state after
compaction before the next model response.

The document has an explicit **Close report** action. It includes every supplied
extension and skill detail row, without the old eight-row preview limit. The Memory section separates the initial `summary.md`, `index.md`, and schema
context from identifiable recalls of files in the session memory projection.
Configured hosts enable this feature by loading the package in their extension
list; it does not require a client-specific built-in switch.

## Composition

```ts
import contextViewExtension from '@felan-ai/ext-context-view';
```

The default export needs no feature-specific service or presenter hint. It
escapes untrusted labels, validates the 256 KiB document budget, and rejects
oversized or incomplete reports rather than silently truncating them. Closing
or session shutdown settles the presentation, including a handle returned after
cancellation. The document cannot change the model or context.

The common
document sends only report measurements and display labels. It does not send
prompt text, memory documents, credentials, or runtime handles. The interaction
can only be closed; it cannot change the model or context. Unknown context
windows remain unknown, and the report remains an estimate, not a billing
measurement.

The package consumes the public Pi composition surface from
`@felan-ai/agent-core`. It
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
