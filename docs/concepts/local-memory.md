# Local memory architecture

Felan's local memory is an account-free, project-keyed Markdown wiki outside
the customer repository. The design separates **reading existing memory** from
**recording evidence** and from **publishing a new canonical snapshot**.

## Storage model

Canonical project memory lives under:

```text
$FELAN_AGENT_DIR/memory/v1/projects/<sha256-project-key>/
  control.json
  state.json
  current/
    summary.md
    index.md
    pages/...
  staging/
  runs/<memory-run-id>/
```

The `builtinExtensions.memory` setting in `settings.json` controls whether the
memory extension is loaded. Like other built-ins, changes take effect when
Felan next constructs a root session. Project `control.json` owns
retry deadlines, attempt ownership, and automatic disablement without changing
the checkpoint-compatible `state.json` format.

Each worker also uses a standard Pi `SessionManager` JSONL file under
`<sessionDir>/memory`. Its linked `runs/<memory-run-id>` directory contains the
manifest and bounded diagnostic workspace. This metadata classifies retained
evidence; filesystem ownership checks, bounded reads, and publication leases
remain the execution safety boundary.

The project key is derived from the canonical Git root, or the canonical cwd
when no repository exists. Felan does not create `<repository>/.memory`.

Each root session receives a non-authoritative projection at:

```text
$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>/.memory/
```

The projection makes links in the loaded summary and root index inspectable by
the session and its child readers. Editing it directly does not publish to the
canonical store. Child sessions can recall the projection but do not contribute
their own evidence.

## Roles and ownership

The portable `@felan-ai/ext-memory` package owns the artifact schema,
validation, hydration, root checkpoint contracts, and reader/root extension
behavior. It does not choose a project scope, schedule a worker, call a model,
or publish files.

The local TUI owns the coordinator, automatic evidence/time gates, startup
recovery, retries, shutdown cancellation, model selection, retained sessions,
history UI, staging, validation, and publication. Automatic processing requires
five accepted checkpoint updates and one hour since the latest successful
publication; repeated updates from one root session count. The absolute
publication deadline is reconstructed by later processes, so closing Felan does
not discard pending work. No portable memory-session-kind contract is added. A
managed host can implement an
equivalent coordinator without changing the portable package.

Felan Platform keeps its separate Supabase persistence, cron scheduling, team
archive, and entitlement flows. The local TUI policy does not change those
systems or their database contracts.

## Lifecycle

```text
root session settles
        |
        v
checkpoint cursor + session evidence
        |
        v
host materializes bounded active-branch evidence
        |
        v
staging/.dreaming/input + staged .memory filesystem
        |
        v
disposable memory worker edits staged Markdown
        |
        v
deterministic validation + semantic maintenance
        |
        v
single-writer publication to canonical current/
```

### 1. Checkpoint evidence

Settled root sessions record transcript cursors. The host reads the append-only
JSONL source with a bounded snapshot and streams only the visible active-branch
delta. Abandoned branches and injected hidden memory context are excluded. The
dreamer applies the retention policy to distinguish useful evidence from raw
tool output and bookkeeping.

### 2. Evidence materialization

The host redacts staged evidence and caps each transcript at 256 KiB. A large
source session file is not rejected solely because its total size is large. A
changed, missing, or malformed source remains pending without blocking valid
checkpoints in the same batch.

### 3. Dreamer worker

The worker is one disposable headless Pi session over immutable staged input and
staged Markdown. It has only `read`, `ls`, `edit`, and `write`; no normal Felan
extensions, skills, repository context, credentials, or process execution. Its
only execution failsafe is a one-hour wall-clock timeout. It returns a concise
summary only after editing the staged filesystem.

The active authenticated root-session model is preferred; another authenticated
available model may be used when the selected model is unavailable. With no
authenticated model, processing remains pending.

### 4. Validation and publication

The coordinator validates the complete staged Markdown filesystem before
publication. It enforces safe unique paths, bounded artifact size, required
prompt files, and page source provenance. Links and navigation are ordinary
content and do not block publication. The prompt keeps the wiki sparse rather than mirroring the
repository: it prioritizes durable user-authored facts, preferences, decisions,
corrections, and uncodified rationale, then verified non-obvious discoveries,
incidents, and runtime or external-system observations. It omits repository
source/docs/config/test details, raw tool output, routine task or verification
status, and repeated paraphrases. Repository-derived content survives only for
important rationale, incidents, mismatches, or hard-to-rediscover constraints
not already recorded in the repository. Every run audits existing memory and
may remove ineligible or duplicate pages even when citations are valid. It
preserves supported contradictions and never invents facts, links, or source IDs.

Publication uses a fenced single-writer lease. Model, validation, cancellation,
timeout, or publication failures leave evidence pending for a retry rather than
partially replacing canonical memory.

## Reading policy

`summary.md` is compact orientation. A substantive answer follows the absolute
links in `index.md` to the relevant area and topic pages and cites their paths
and `Sources` session IDs. A memory snapshot injected into a session is
reference material, not an independent recall, canonical wiki read, or memory
service query.

When a user asks the agent to remember, forget, or change durable memory, the
session records a concise attributed request as direct evidence. It must not
claim that canonical memory changed immediately.

## Failure and recovery

Existing memory remains readable without model credentials. Missing credentials,
source corruption, cancellation, or a lost publication lease leaves affected
evidence pending without spending the attempt-failure budget. Valid checkpoints
in the same batch can still proceed when one source fails deterministically.

After the first failed processing attempt, processing waits 60 seconds; after
the second, it waits 300 seconds. The third consecutive failure durably
disables only that project. Successful publication resets the counter, while
prompts and process restarts do not. `/memory retry` explicitly resets and
retries the current project only when the memory extension is loaded. `/memory
run` does not clear a project breaker. Shutdown and intentional cancellation do
not consume a failure. Both commands return immediately while the requested run
continues in the background. The worker retains its existing one-hour
wall-clock timeout and has no additional turn cap.

Completed run records are retained up to the newest 50 terminal runs. Active
runs and the latest disable-causing evidence are protected. Terminal records
retain their standard session JSONL and `manifest.json`; their disposable
workspace is deleted. Unknown, malformed, or unsafe records are preserved and
ignored rather than blocking new inference.

If a process stops before publication is durably acknowledged, the evidence
remains pending and may be rerun without consuming a failure-budget attempt.
Only durable canonical state plus exact checkpoint cursors proves publication.

Retained sessions appear as `Memory:` entries in the normal picker and through
`/memory runs [id|latest]`. That transcript view is read-only and performs no
model work. Existing explicit resume, import, fork, switch, prompt-history, and
recovery behavior is unchanged; the segregated directory relies on existing
flat ordinary-session discovery rather than a new session-kind guard.

Insights reads retained memory JSONL from the configured session directory and
counts each worker once as a standalone session. It reports recorded usage,
including known compaction usage; it does not infer missing usage or translate
subscription quota percentages into tokens.

Availability-safe read mode enforces filesystem safety and resource bounds but
does not reject the whole snapshot for missing provenance. Strict publication
also treats Markdown links and navigation as best-effort content.

The projection is copied from canonical files when loaded; canonical memory is
the authority. Resolvable summary and root-index paths are rebased only in the
session projection so they remain directly openable from that session.

After installing an updated Felan build, restart existing TUI processes so
workers use the new lifecycle code loaded at process startup.

See [Context and memory](../user-guide/context-and-memory.md) for user commands
and [`@felan-ai/ext-memory`](../../packages/ext-memory/README.md) for the
portable API.
