# ADR 0033: Preserve headless JSON with negotiated events

## Status

Accepted implementation decision for Story 1. Independent review remains paused.

## Context

The existing headless JSON mode prints the native session header and JSON event
stream. Reconstructing that output from normalized session snapshots loses
header metadata, content indexes, provider events, thinking details and tool
timing. Replacing it silently with protocol projections would break consumers.

## Decision

Clients can explicitly negotiate a versioned presentation-event channel. Its
protocol envelope contains only a session ID, presenter identity, sequence and
bounded JSON data; it imports no runtime or provider types. The local daemon
offers the headless JSON presenter only to headless clients. It sends the native
header followed by events adapted to the existing print-mode JSON shape.

The channel is transient and does not replace canonical history, revisions or
request outcomes. A gap, overflow or transport interruption fails the consuming
JSON stream rather than inventing missing events or resubmitting a prompt.
Normal TUI, ACP and other clients do not receive this channel unless they
negotiate an applicable presenter. Shared daemon execution never waits for a
slow output consumer.

## Alternatives considered

- A new JSON projection format would require an intentional public breaking
  change and would not preserve the requested output behavior.
- Reconstructing native fields would fabricate information the projection does
  not contain.
- Adding runtime-specific fields to every canonical session event would couple
  all clients to a compatibility format they do not use.

## Consequences

The host owns native event adaptation. The client prints payloads without
opening session files. Both transport and client output buffers remain bounded.
Reconnect can restore canonical observation, but cannot claim complete replay
of a transient JSON stream.
