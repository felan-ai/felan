# Context and memory

Felan treats repository instructions, Agent Skills, and durable project memory
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
  state.json
  current/
    summary.md
    index.md
    pages/...
```

The project key derives from the canonical Git root, or the canonical cwd when
outside a repository. Felan does not create a canonical `.memory` directory in
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

The local host owns scheduling and model work. A missing authenticated model
leaves evidence pending rather than blocking startup. Processing is idle
batched while Felan runs and catches up after a later launch.

Use:

```text
/memory status
/memory run
/memory enable
/memory disable
/memory open
```

Disabling processing does not delete or hide existing memory.

### Direct remember or forget requests

When you explicitly ask Felan to remember, forget, or change durable memory,
the active session records that request as evidence for a later processing
run. It must not claim that canonical memory changed immediately.

For staging, validation, failure, and publication details, read
[Local memory architecture](../concepts/local-memory.md). The portable package
contract is documented in [`@felan-ai/ext-memory`](../../packages/ext-memory/README.md).
