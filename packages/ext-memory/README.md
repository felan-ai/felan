# @felan-ai/ext-memory

Portable local-first memory contracts, Markdown artifact policy, validation,
and Pi extension behavior for Felan hosts.

Applications bind the extension to their own storage and coordinator:

```ts
import { createMemoryExtension } from '@felan-ai/ext-memory';

createMemoryExtension({
  role: 'root',
  host,
});
```

`root` sessions read memory and report settled transcript cursors. `reader`
sessions only read memory. The package does not choose a project/team scope,
schedule workers, call a model, publish artifacts, or import a cloud/local host.
After a root checkpoint is recorded, the application host decides whether to
schedule processing. The portable extension never wakes a worker itself.

Memory is a Markdown wiki containing `summary.md`, `index.md`, and topical
pages under `pages/`. The summary is orientation only: substantive claims
should follow the index to relevant area and topic pages and cite their paths
and `Sources` session IDs. Hosts project a non-authoritative copy into each
root session and retain canonical storage outside customer repositories.

Markdown links are ordinary untrusted content and never make an artifact
invalid. Publication validation enforces the artifact shape and version, safe
and unique paths, required prompt files, resource limits, page provenance, and
the optional source-session allow-list; link targets and navigation quality are
best-effort content concerns. Availability-sensitive consumers can use
`mode: 'read'`; it still enforces bounded regular Markdown files at safe,
unique paths, but treats provenance defects as nonfatal and supplies empty
summary/index defaults when either prompt file is absent. Publication callers
can disable provenance checks with `requireSources` and restrict citations with
`sourceSessionIds`.

The extension appends one hidden, persisted memory-context message when a
session starts. Later provider calls reuse that session context instead of
injecting a new message on every `context` event. If compaction or tree
navigation removes the message from the active branch, the extension restores
one copy. The message is excluded from checkpoint evidence so memory cannot
learn its own injected prompt.

When a user explicitly asks to remember, forget, or change memory, the session
prompt asks the agent to leave a concise, attributed memory note rather than
claim an immediate canonical update. A later dreamer treats the original
user-authored request as direct evidence; the assistant note is only a pointer
to that request.

Local Felan's host-owned coordinator runs dreaming as a disposable headless Pi
session over staged `.dreaming/input` and `.memory` directories. The dreamer
uses only read/list/edit/write file tools, has no normal extensions, skills,
repository access, or process execution, and returns a summary only after
editing the staged Markdown artifact. The host validates and publishes that
filesystem output; failed or cancelled work remains pending. The local worker
uses the host-selected authenticated session model and may fall back to another
authenticated available model when that selection is unavailable. It does not
impose separate turn, tool-call, or per-file I/O budgets; its only execution
failsafe is a one-hour wall-clock timeout. The host-side evidence
materializer is a separate boundary: it streams the checkpoint's visible
active-branch delta from JSONL, ignores unrelated branches, redacts it, and
caps each staged transcript at 256 KiB. The dreamer uses the structured session
records to ignore low-value tool and bookkeeping content according to the
retention policy. Large source session files are not rejected solely for their
total size. Deterministic source failures remain pending for retry, while valid
checkpoints in the same batch can still be published.

The memory schema keeps the wiki sparse. It prioritizes durable user-authored
facts, preferences, decisions, corrections, and uncodified rationale, followed
by verified non-obvious discoveries, incidents, and runtime or external-system
observations. It does not mirror repository source, documentation, configuration,
tests, routine task status, raw tool output, or repeated summaries. Repository
facts are retained only when they capture useful rationale, an incident, a
mismatch, or a hard-to-rediscover constraint that is not recorded in the
repository. Each dreaming run audits the complete existing wiki and removes
ineligible, stale, duplicate, overlapping, or unnecessary content; valid source
citation alone does not make a claim worth keeping.

## Development

Source: `packages/ext-memory` in <https://github.com/felan-ai/felan>.

```sh
pnpm --filter @felan-ai/ext-memory build
pnpm --filter @felan-ai/ext-memory type-check
pnpm --filter @felan-ai/ext-memory test
```

## Package boundary and requirements

The package owns the portable memory schema, validation, hydration, checkpoint
contracts, and root/reader extension behavior. The host owns project scoping,
canonical storage, evidence materialization, scheduling, model calls, staging,
locking, validation publication, and retry policy. It requires a compatible
`@felan-ai/agent-core` peer and remains independent of TUI, Supabase, and cloud
application modules.

Memory and transcript content is untrusted reference data and cannot override
system, developer, user, authorization, or tool-safety rules.

## Related documentation

- [Context and memory](../../docs/user-guide/context-and-memory.md)
- [Local memory architecture](../../docs/concepts/local-memory.md)
- [Runtime and security](../../docs/concepts/runtime-and-security.md)

## Attribution

The Markdown memory schema and dreaming policy were adapted from Felan's
filesystem-memory implementation. The remaining package code is original Felan
project code. See [NOTICE](NOTICE) and [LICENSE](LICENSE).
