# ADR 0031: Bind project trust to the creating client

## Status

Accepted implementation decision for Story 1. Independent review remains paused.

## Context

The local daemon must preserve explicit project-extension trust without loading
project code in the client. Trust belongs to the TUI creating the session, not
whichever client answers first. Ordinary session questions still survive client
disconnects and remain answerable by eligible attached clients.

A host-scoped trust answer also uses the host admission lane. Waiting for that
answer while holding the lane would prevent the answer itself from executing.

## Decision

Prepare new interactive roots before entering ordered admission. Preparation
reads only bounded local configuration and directory metadata, asks the creating
TUI when required, and returns canonical extension paths. The admitted request
retains its original identity and payload. The command revalidates the canonical
working directory before opening the session and persists the resolved paths in
the existing session launch profile.

Host interaction scopes may name a recipient connection. The server delivers
them only to that TUI, and the broker checks the recipient again when answering.
Disconnect cancels its outstanding recipient-bound prompts. Such prompts are
cancelled on broker reconstruction rather than reassigned after restart.
Unscoped host prompts and ordinary session questions keep their existing rules.

Trust choices retain folder, parent-folder, deny, and dismissal behavior. Denial
or dismissal skips project extensions; it does not implicitly approve them.
Noninteractive clients never discover these interactive extension sources.

## Alternatives considered

- Client-side discovery would violate daemon ownership and allow configuration
  to differ between attached clients.
- Waiting inside ordered admission would deadlock host-scoped answers.
- Letting any TUI approve would change the creator-affinity security boundary.
- Changing the admitted payload to contain discovered paths would break request
  identity and retry consistency.

## Consequences

Preparation is coalesced per request identity, bounded by connection admission,
cancelled on creator loss, and included in server shutdown settlement. It does
not hold the host admission lane. Directory scans and loaded path counts have
explicit limits. Stored profile paths remain subject to the existing ownership,
root-only loading, and shared launch-environment rules.
