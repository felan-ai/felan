# ADR 0027: Expose scoped subagent views and controls

## Context

The agent navigator must remain usable while its parent model is running. The
existing command invocation starts an admitted parent turn and therefore cannot
serve as the navigator's control channel during another turn. Children already
have real registry sessions, and the local subagent host owns their records,
steering, cancellation and parent-child authorization.

## Decision

Expose capability-advertised, session-scoped agent listing, result reading,
steering and cancellation operations. Listing and result reads are read-only.
Steering and cancellation use ordinary ordered admission and the existing
subagent host, with cancellation retaining safety admission. The bound parent
host—not a client-supplied path or root identifier—determines visible children.

The client reads live child transcripts through actual session attachments.
Display metadata remains data in the existing projection; no session facade or
executable renderer crosses the transport. The existing agents command can ask
a compatible client to open the navigator, while client shortcuts open it
locally without starting a parent turn.

This choice is recorded by Felan under the user's instruction to implement the
design, preserve current behavior where unspecified, and document alternatives
without further questions. It is not a separate user or reviewer approval.

## Alternatives considered

- Routing each control through command invocation would either reject busy
  parents or broaden arbitrary extension-command concurrency.
- A permanently pending broker interaction would consume answer capacity and
  require special scheduling to avoid blocking ordinary questions.
- Repeated whole-transcript presentation snapshots would duplicate streaming
  and recovery machinery and impose unnecessary transport and storage work.

## Consequences

The protocol gains optional operations that clients must check in the handshake.
Existing parent-turn and arbitrary-command behavior stays unchanged. Tests must
cover direct-child authorization, request replay, cancellation at capacity,
client detach/reconnect, paging and disposal. Public-package version assessment
remains part of the final release task.
