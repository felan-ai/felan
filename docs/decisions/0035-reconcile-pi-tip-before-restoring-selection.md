# ADR 0035: Reconcile the observed Pi tip before restoring branch selection

## Status

Superseded by [ADR 0038](0038-resume-transcripts-at-their-last-entry.md).
Implementation decision within the approved Story 1 content-authority contract.
No automatic request replay is introduced.

## Context

A real daemon-crash test preserved a user message in Pi JSONL but hid it after
restart. Control metadata still selected an earlier setup entry because its
projection checkpoint lagged the append. Restoring that pointer unconditionally
discarded the newer context from the visible branch without deleting the file.
Conversely, always choosing the file's last entry would discard an intentional
selection of an older branch when no new work was appended.

## Decision

Checkpoint the selected branch together with the last observed physical Pi entry.
Both are bounded opaque IDs in the existing control store, not another transcript.
Before runtime composition, the owning profile restores the explicit selection
when the physical tip is unchanged. If new entries form a continuous extension
of that selected branch, the Pi-durable tip wins. Missing checkpoints or an
inconsistent extension fail closed instead of guessing a branch.

The cursor is refreshed through ordinary metadata capacity and checkpointed
before admitted execution or a durable interaction continuation. It does not use
the emergency outcome reserve. Old rows without an observed tip conservatively
retain their prior selection; the missing evidence is not invented.

## Alternatives

- Restore control selection unconditionally: simple, but hides Pi-durable work
  in the reproduced crash window.
- Always use the newest Pi entry: simple, but loses deliberate older selections.
- Synchronize two files atomically or replay the request: neither is available;
  replay would violate the admitted ambiguity contract.

## Consequences

Profiles receive the optional branch cursor when resuming and apply it before
constructing runtime context. A restored session may show interrupted partial
work but never resumes its model/tool execution implicitly. Retained request
outcomes and current run state remain separate facts. The new optional control
metadata and profile input require the final package/API compatibility review.
