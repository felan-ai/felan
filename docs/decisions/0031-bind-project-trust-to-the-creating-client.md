# ADR 0031: Bind project trust to the creating client

## Status

Accepted implementation decision for Story 1. Independent review remains paused.
Amended by [ADR 0043](0043-apply-external-extension-settings-per-host.md):
discovery applies to every new root and its children; trust prompts still belong
only to the creating TUI. Related: [ADR 0013](0013-opt-in-pi-extension-directories.md).

## Context

The local daemon must preserve explicit project-extension trust without loading
project code in the client. Trust belongs to the TUI creating the session, not
whichever client answers first. Ordinary session questions still survive client
disconnects and remain answerable by eligible attached clients.

A host-scoped trust answer also uses the host admission lane. Waiting for that
answer while holding the lane would prevent the answer itself from executing.

## Decision

Prepare every new root before entering ordered admission, including roots
created through ACP, headless runs, the web and `session.import`. Preparation
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
ACP, headless and web creates load host-enabled external extension sources,
but skip project folders without a trust decision and save no decision. Folders
already trusted directly or through a parent load for every creator. ACP's
first `session/new` cannot safely present a host prompt before a session is
ready; headless runs cancel prompts and web creates have no local client.

## Alternatives considered

- Client-side discovery would violate daemon ownership and allow configuration
  to differ between attached clients.
- Waiting inside ordered admission would deadlock host-scoped answers.
- Letting any TUI approve would change the creator-affinity security boundary.
- Changing the admitted payload to contain discovered paths would break request
  identity and retry consistency.

## Consequences

Local-client preparation is coalesced per request identity, bounded by connection
admission, cancelled on creator loss, and included in server shutdown settlement.
It does not hold the host admission lane. Directory scans and loaded path counts have
explicit limits. Stored paths remain subject to ownership and shared
launch-environment rules. Children load their root's external extension paths;
resume and clone/fork retain saved paths instead of discovering them again.
