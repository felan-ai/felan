# Local memory architecture

Felan's local memory is an account-free, project-keyed Markdown wiki outside
the customer repository. The design separates **reading existing memory** from
**recording evidence** and from **publishing a new canonical snapshot**.

## Storage model

Canonical project memory lives under:

```text
$FELAN_AGENT_DIR/memory/v1/projects/<sha256-project-key>/
  state.json
  current/
    summary.md
    index.md
    pages/...
  staging/
```

The project key is derived from the canonical Git root, or the canonical cwd
when no repository exists. Felan does not create `<repository>/.memory`.

Each root session receives a non-authoritative projection at:

```text
$FELAN_AGENT_DIR/storage/sessions/<encoded-root-session-id>/.memory/
```

The projection makes the loaded summary and absolute index links inspectable by
the session and its child readers. Editing it directly does not publish to the
canonical store. Child sessions can recall the projection but do not contribute
their own evidence.

## Roles and ownership

The portable `@felan-ai/ext-memory` package owns the artifact schema,
validation, hydration, root checkpoint contracts, and reader/root extension
behavior. It does not choose a project scope, schedule a worker, call a model,
or publish files.

The local TUI owns the coordinator, idle batching, startup recovery, retries,
shutdown cancellation, model selection, staging, validation, and publication.
A managed host can implement an equivalent coordinator without changing the
portable package.

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
delta. Abandoned branches, injected hidden memory context, and unrelated large
tool output are excluded.

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
publication. It preserves valid historical citations, updates every affected
topic/entity/concept page, adds meaningful cross-links, marks superseded claims
and unresolved contradictions, and performs a bounded semantic lint. It never
invents facts, links, or source IDs.

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
source corruption, worker failure, validation failure, cancellation, timeout,
or a lost publication lease leaves affected evidence pending. `/memory run`, a
newer cursor, or a later launch can retry it. Valid checkpoints in the same
batch can still proceed when one source fails deterministically.

The projection is copied from canonical files when loaded; canonical memory is
the authority. Root-index paths are rebased only in the session projection so
they remain directly openable from that session.

See [Context and memory](../user-guide/context-and-memory.md) for user commands
and [`@felan-ai/ext-memory`](../../packages/ext-memory/README.md) for the
portable API.
