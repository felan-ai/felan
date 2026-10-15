# ADR 0038: Resume transcripts at their last entry

## Status

Supersedes [ADR 0035](0035-reconcile-pi-tip-before-restoring-selection.md).

## Context

ADR 0035 restored a daemon-recorded branch selection on resume and failed closed
when the transcript had entries the recorded selection did not explain. Transcripts
appended on an older branch, or written by another process (for example a 0.28
felan session in the same sessions folder), therefore became permanently
unopenable: history, checkpoint and resume all returned `stale`. Memory startup
recovery then looped on the failure every monitor tick.

Pi has no persisted leaf. A transcript opens at its last entry, and navigation
without a following message is in-memory only.

## Decision

A transcript's active branch is its last entry in file order. The daemon resumes
Pi with its default position, and the session history service reports that entry
as `branch`. Checkpoints and history pages digest the branch ending at that entry.

The daemon still records `branch` and `observedTip` in control metadata as live
session state for `branch.updated` events. Neither gates resume or history reads,
and existing control rows remain valid.

## Consequences

- A session unloaded after navigation without a new message reopens at its last
  entry, not the navigated position. This matches 0.28, which never unloaded
  sessions.
- Transcripts written outside the daemon are read and resumed without `stale`.
- A read can still return `stale` when the file changes during the read; callers
  retry.
- `observedTip` is persisted but no longer read for decisions; removing it needs a
  control-state migration and is deferred.
