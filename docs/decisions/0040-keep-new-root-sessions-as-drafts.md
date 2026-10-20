# ADR 0040: Keep new root sessions as drafts until their first message

## Status

Accepted.

## Context

Each interactive start ran `sessions.create`, which records a session and writes
its transcript header at once. A window opened and closed without a message left
an empty session in `/resume` and in the daemon's counts for good. The footer
(model, context, cost, limits, extension statuses) is produced by a live session
runtime, so a client cannot draw it before a session exists.

## Decision

`sessions.create` roots are drafts. A draft keeps its runtime and can be attached
by ID, but clients do not list or count it. Its first user, assistant or shell
message clears the draft flag. The daemon discards a draft that has no
conversation, children, interactions or processes after `idleMs` without an
attachment. After a restart, a draft that was not resident is held for `idleMs`
from startup, so a reconnecting client keeps it. Discarding tombstones the
session and removes its transcript, in the same order as deletion. A draft that
has any of those becomes an ordinary session instead.

`sessions.list` returns the newest activity first, then session ID. Its cursor
carries the last row's position, so a row that moves or vanishes does not break
paging. Pre-daemon transcripts are indexed from their headers. Their titles and
previews are read on request and warmed in the background from startup, newest
first.

## Alternatives considered

- Start without a daemon session and draw a reduced footer. Rejected: the footer
  would differ from a real session before the first message.
- A protocol flag or a create-with-prompt operation. Rejected: it needs capability
  negotiation for a daemon-side lifecycle change; `clientRoot` already identifies
  client-created roots.
- Filter empty sessions in clients only. Rejected: counts, `--continue` and other
  clients would still disagree with the daemon.

## Consequences

- An ACP `session/load` of a discarded, never-prompted draft returns `not_found`.
- Discarding leaves per-session storage such as `.memory` and `background-bash`
  in place, as session deletion already does.
- Existing empty sessions remain listed; there is no migration.
- `host.status` session counts exclude drafts.
- Pre-daemon transcripts are listed without a full read, so a cold first page no
  longer waits for every transcript.
