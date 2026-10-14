# @felan-ai/ext-memory

Portable local-first memory contracts, Markdown artifact policy, validation,
and Pi extension behavior for Felan hosts.

The package root requires the core `felan.runtime@1`, `felan.models@1`, and
`felan.sessions@1` services. It owns the local store, project coordination,
checkpoint recovery, dreaming, retention and `/memory` commands. There is no
memory-specific provider or service contract.

Only a loaded root extension schedules work. Reader sessions recall the current
artifact without recording checkpoints or starting workers. Files and atomic
storage operations use the scoped Runtime; model selection uses the authenticated
Models facade. Restricted dreaming sessions and lifecycle settlement go through
Sessions. Missing capabilities prevent activation rather than opening an
independent, untracked worker.

The canonical layout remains `<agentDir>/memory/v1/projects/<projectKey>` and
retained journals remain under `<agentDir>/sessions/memory`. A session's `.memory`
directory is a non-authoritative projection. Existing checkpoints and artifacts
are not migrated or reset by this change.

Retained workers compose an in-memory Pi journal; Runtime appends its entries to
the retained file and flushes them before recording run outcomes. The extension
does not use Pi's native filesystem persistence.

`materializeMemorySessionCheckpoint` reads revision-pinned, paginated Sessions
history with original identities and complete journals, including abandoned
branches. Missing history, revision drift and changed evidence remain explicit
failures, not empty successful projections.

Status, history views and command feedback use `pi.ui`. A client may render the
memory history hint, but it receives the same generic elements and actions as
other clients. `/memory open` asks an eligible host console before launching a
filesystem viewer. Unavailable presentation never prevents checkpoint capture.

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

The extension's coordinator runs dreaming as a disposable headless Pi
session over staged `.dreaming/input` and `.memory` directories. The dreamer
uses read/list/grep/edit/write file tools plus a scoped tool that removes
individual non-index Markdown pages under staged `.memory/pages`. It has no
normal extensions, skills, repository access, or shell execution. Grep can
launch only `rg` over staged inputs and wiki files; arbitrary commands remain denied. It returns
a summary only after editing the staged Markdown artifact. The extension validates
and publishes that filesystem output; failed or cancelled work remains pending.
With an optional runtime classifier, the portable extension groups contiguous
session evidence into provider-sized chunks and asks whether each entry needs
inspection or is wholly transient noise. The Models service supplies the
classifier; the extension stages read-only inspect and noise JSONL for each session, and
writes a compact map of the staged paths. For text-only inspect records the host
also stages a worker-readable `inspect.txt` view with session/entry IDs, role,
tool name and complete text. Mixed or unsupported blocks remain in the original
inspect JSONL instead of being silently shortened. The worker reads the view
when available, otherwise the JSONL source,
may grep noise for context, organizes the wiki, and preserves original entry IDs
and source provenance. Original transcripts remain staged and available for
verification or a full-audit fallback. Oversized or uncertain items are
inspected; missing or unusable classification uses the original full-audit
workflow. Triage does not decide final wiki retention or summary placement.
The classifier packs questions by session against `canEvaluate` capacity;
oversized entries, missing answers and interactive user answers remain safe
for inspection. The worker reconciles inspect evidence across chunks
and sessions, audits the prior wiki independently, and uses medium thinking.
It selects that model from the
root session's configured model scope, preferring its provider and model
family, without escalating; evidence remains pending when no eligible model
is available. Classifier-bound transcript excerpts may leave the
local process; recognized credential patterns are redacted, but unknown
secrets may remain.
It does not impose separate turn, tool-call, or per-file I/O budgets; its only
execution failsafe is a one-hour wall-clock timeout. Hosts can pass a replayable
async JSONL line source to `materializeMemoryInputDelta` to validate checkpoint
lineage and create a deterministic, redacted visible-branch delta. Diverged
lineages emit the complete current branch. Output limits reject an oversized
projection instead of truncating a JSONL record. Sessions providers supply the complete journal; the extension stages successful
projections. Large source session
files are not rejected solely for their total size. Deterministic source
failures remain pending for retry, while valid checkpoints in the same batch
can still be published.

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

The package owns memory policy and lifecycle behavior. Runtime providers own
filesystem/process access, Models providers own credentials and allowed-model
scope, and Sessions providers own worker admission and canonical session
lifetime. The package requires a compatible `@felan-ai/agent-core` peer and has
no application, TUI, Supabase or cloud-runtime dependency.

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
