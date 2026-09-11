# Context and memory

Felan Code treats repository instructions, Agent Skills, and durable project memory
as separate context sources with different ownership and lifecycles.

## Startup project instructions

Agent Core loads at most one instruction file from the session working
directory:

1. `AGENTS.md`
2. `CLAUDE.md`

Missing, blank, and unreadable candidates are nonfatal. The selected file is
rendered as path-labelled project context rather than as an application prompt
append.

## Progressive nested instructions

The progressive-context extension looks below the session cwd. After a
successful structured `read` or decoded CLI `@file` attachment, it checks each
new nested directory on the path for:

1. `AGENTS.md`
2. `CLAUDE.md`

Loaded files affect subsequent model calls and are deduplicated for the session.
Unchanged instructions stay at one stable hidden context position while later
conversation history appends after them. Newly discovered instructions and
context compaction re-anchor the updated bundle once. Shell reads do not trigger
discovery, and a file outside the session cwd cannot introduce nested project
instructions.

Use `/progressive-context` to inspect what has been loaded.

Use `/context` to inspect the assembled context-window estimate. The report
breaks usage into the system prompt, tools, project context, skills, memory,
messages, other context, and free space. It renders inline by default; configure
`extensionConfig.contextView.displayMode` as `overlay` for a centered popup.
Estimates are based on the current prompt and session entries and are not
provider billing measurements; immediately after compaction, the provider usage
may remain unknown until the next model response.

The Memory row includes the injected `summary.md`, `index.md`, and schema, plus
identifiable reads from the session memory projection. Other conversation
messages are counted under Messages.

## Session compaction and recall

The default session-compaction extension asks the configured summary model once
for a bounded continuation checkpoint after deterministic extraction of the prepared
eviction span. `inherit` is the default; tier values select an exact
text-capable model from the allowed catalog, preferring the active
provider/family. An unavailable tier falls back to inherit. Evidence is
priority-packed while preserving chronological order. For a split turn, user
input plus assistant text and reasoning are mandatory. Tool interactions are
reduced to attributable outcomes: file reads keep paths instead of file bodies,
writes and patches keep affected paths and status instead of payloads, commands
keep bounded output, and failure text remains high priority. It preserves
explicit constraints and decisions, open loops, recorded command/test outcomes,
task snapshots, and RTK truncation pointers with source IDs. If mandatory
content cannot fit the bounded prompt, it falls through to native Pi before
making an extension request. Pi still owns cut points, retained tails, overflow
retry, session trees, and persistence. This improves recoverability but does not
prove semantic completeness.

If the extension cannot safely prepare a prompt, the configured model request
fails or times out, or the response is rejected, it warns that Pi native
compaction will take over. It also persists one bounded metadata-only fallback
diagnostic in the session. That custom entry is not shown, sent to the model,
or returned by `session_recall`; it records why control was delegated, not that
native compaction succeeded. User cancellation is not a fallback.

`session_recall` searches only the active `SessionManager.getBranch()` lineage.
It returns bounded, untrusted historical evidence with stable session and entry
IDs. It does not read sibling branches, prior sessions, or RTK recovery files;
an RTK recovery pointer does not promise access to the original output. Disable
the feature with `builtinExtensions.sessionCompaction: false` to restore Pi's
native summarization and remove the tool.

Memory is intentionally selective. It prioritizes durable user-authored
preferences, decisions, corrections, important facts, and rationale not recorded
elsewhere, followed by non-obvious agent discoveries, incidents, and runtime or
external-system observations. It does not copy repository structure, APIs,
commands, configuration, documentation, tests, routine task status, raw tool
output, or repeated summaries that a future agent can cheaply recover. Each
dreaming run also removes old duplicate or repository-mirror content when it is
no longer useful.

Existing memory is cleaned the next time that project has an ordinary pending
memory run after a fresh process loads the updated prompt. Projects with no
pending evidence do not start a model call solely because the prompt changed.

## Agent Skills

The local host explicitly loads Agent Skills from:

```text
~/.agents/skills
<workspace>/.agents/skills
```

Skills are shared with local subagents. Ambient Pi skill paths and package
resources remain filtered.

## Application prompt append

`$FELAN_AGENT_DIR/APPEND_SYSTEM.md` is an optional application-wide prompt
append. It follows Agent Core's base prompt and enabled extension capabilities.
Use it for stable local-host preferences, not repository-specific instructions.

## Local-first memory

Local memory is enabled by default and does not require a Felan account. It
consolidates settled root-session evidence into an inspectable, project-scoped
Markdown wiki:

```text
$FELAN_AGENT_DIR/memory/v1/projects/<project-hash>/
  control.json
  state.json
  current/
    summary.md
    index.md
    pages/...
  runs/<memory-run-id>/
```

Memory worker transcripts are standard Pi JSONL sessions under
`<sessionDir>/memory`. They appear as `Memory:` entries in the session picker
and can be inspected without resuming them. Their linked run directories keep
bounded input, output, manifest, and diagnostic evidence.

The project key derives from the canonical Git root, or the canonical cwd when
outside a repository. Felan Code does not create a canonical `.memory` directory in
the customer repository.

Each root session receives a non-authoritative projection at:

```text
$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>/.memory/
```

Root sessions record settled evidence; child sessions can read the projection
but do not publish evidence. Editing the projection does not update canonical
memory.

### Reading memory

`summary.md` is orientation, not evidence for a substantive claim. The agent
follows `index.md` into relevant pages and cites the page paths and `Sources`
session IDs. Existing memory remains readable when no model credential is
available.

### Processing memory

The local host owns scheduling and model work. It uses medium thinking with an
authenticated low-tier model from the active session's configured model scope,
preferring that session's provider and model family. It does not silently
escalate to a more expensive tier. If no eligible model is available, evidence
remains pending rather than blocking startup.
Automatic processing waits for five accepted checkpoint updates and 24 hours
since the latest successful publication. Updates from the same root session
count; identical cursors do not.
The deadline is persisted through canonical state, so a later Felan Code launch can
catch up if the earlier process closes. `/memory run` remains an explicit
immediate request.

Use:

```text
/memory
/memory run
/memory open
```

After a failed processing attempt, the current project waits one minute before
the second attempt and five minutes before the third. A third consecutive
failure automatically disables processing for that project across prompts,
sessions, and restarts. A successful publication resets the counter. The
`/memory run` clears the current project's backoff or automatic-disable breaker
when needed, then retries it. It otherwise starts ordinary immediate
processing. The command returns immediately after requesting background work;
use the footer or `/memory` to follow progress.

The footer shows processing, backoff, and pending counts. An automatically
disabled project shows `Memory: disabled` and warns once when an interactive
session starts or resumes in that project. Existing memory remains readable.

Use `/memory` to view status and browse retained runs in one pane. Selecting a
run is read-only and never starts a model. Existing explicit session resume,
import, fork, and switch behavior is unchanged.

Felan Code retains the newest 50 completed run records. Each retained record keeps
its standard JSONL and manifest; its disposable processing workspace is removed
after completion. Active runs and the latest disable-causing evidence are
protected. Unverifiable records are preserved and ignored rather than deleted.
An ambiguous process interruption leaves the checkpoint pending for rerun and
does not consume the failure budget; only durably acknowledged canonical state
counts as a successful publication.

Retained workers contribute their recorded model usage once to `/insights`, as
standalone sessions. Missing usage remains unknown; Felan Code does not convert
subscription quota percentages into token usage.

### Direct remember or forget requests

When you explicitly ask Felan Code to remember, forget, or change durable memory,
the active session records that request as evidence for a later processing
run. It must not claim that canonical memory changed immediately.

For staging, validation, failure, and publication details, read
[Local memory architecture](../concepts/local-memory.md). The portable package
contract is documented in [`@felan-ai/ext-memory`](../../packages/ext-memory/README.md).
