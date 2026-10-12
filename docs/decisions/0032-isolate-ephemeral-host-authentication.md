# ADR 0032: Isolate ephemeral host authentication

## Status

Accepted implementation decision for Story 1. Independent review remains paused.

## Context

Provider sign-in can require API keys, authorization codes, browser callbacks,
and cancellation of provider code that does not honor abort. These values must
not enter durable interaction answers, session history, or control-store request
metadata. Exiting a sign-in flow must not stop other sessions in the shared
daemon.

## Decision

The daemon owns bounded, connection-bound setup jobs. Starting a job is an
explicit, negotiated, durable action containing no credential values. Job reads
and secret answers are ephemeral protocol operations. A completed answer keeps
only its digest and redacted envelope in the client's retry cache. Another
connection cannot read or answer the job.

Provider sign-in runs in a daemon-owned stdio subprocess launched through
`AgentRuntime`. It inherits the unchanged daemon environment and uses Pi's
existing local credential store and locking. It is not a session worker and does
not implement environment provisioning. Stdin carries bounded secret answers;
stdout carries validated private UI events. Provider diagnostics are not copied
to operational logs. Cancellation terminates and joins this owned process;
failed process cleanup blocks daemon shutdown completion.

An unref'ed worker-thread guard checks the daemon parent identity independently
of the provider's main event loop and kills only its own authentication process
when the parent disappears. Stdin EOF also stops the worker. This prevents a
blocked provider from retaining a detached authentication process after abrupt
daemon death; it is not a session execution worker.

Dependency installation uses the same explicit setup lifecycle and the existing
reviewed installers. Only known dependencies and actions are accepted. Changes
to enablement and onboarding state use the existing locked settings boundary.
Local browser/report opening is a separate authorized host action referring to
a known pending interaction or setup-job link, not an arbitrary client command.

## Alternatives considered

- Durable `interaction.answer` is inappropriate for credentials.
- Running provider login inside the daemon leaves abort-ignoring provider
  handles in the process shared by all sessions.
- Client-side installers and credential stores would split host ownership and
  create different behavior across clients.
- Killing or restarting the daemon to cancel sign-in would interrupt unrelated
  sessions.

## Consequences

Setup jobs do not resume after daemon restart. A user explicitly starts a new
flow; uncertain external outcomes are never replayed as fresh actions. A
cancelled flow may already have completed an authorized credential write, so
credential files are never rolled back speculatively. New sessions and explicit
reloads retain their existing configuration semantics.
