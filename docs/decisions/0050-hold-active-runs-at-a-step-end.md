# ADR 0050: Hold active runs at a step end

> Status: Accepted
> Date: 2026-11-27
> Deciders: Felan maintainers
> Related: [ADR 0049](0049-wait-on-a-detached-job-for-foreground-bash.md),
> [contract](../shared-session-daemon/contract-change-requests-felan.md#holding-active-runs-for-host-restarts)

## Context

A host update restarts the daemon. Until now a `hold` restart was accepted only
on an idle host, so a busy host waited for every run to end, up to two hours,
and was then force-restarted, which marked its runs `interrupted`. A run is a
loop of steps; one step is a model response and the tool calls it asked for.
After a step's tool results are saved, the run's whole state is in its
transcript, so a run that stops there can continue in another daemon.

## Decision

The daemon wraps each session agent's `finishTurn` hook. While a hold is
active, a step whose tool calls continue the run waits in that hook. The wait
starts after the assistant message and every tool result are saved, and before
the next model request. A step without tool calls, a batch whose tool calls end
the run, and a failed or aborted response keep their normal course. When every
resident session is idle or waiting this way and no other work runs, the daemon
writes one versioned continue record per waiting run. The record holds the run
ID, the transcript leaf and the queued user messages, and goes to its own
`held_runs` table in the control store. Then the daemon answers `held`.

- A cancelled or expired hold deletes the records and releases each waiting
  step with its original decision, so the run continues in place as if it had
  only paused.
- A stop after `held` aborts the waiting runs. An abort releases the hook with
  `{ action: 'end' }`, so the run ends without another request and without an
  aborted message. Their runs stay `running` and their child executions stay
  unfinished.
- The next daemon consumes the records at startup. It restores each session
  whose run and transcript leaf still match, re-queues the saved messages, and
  starts the next step through Pi's normal run start with a hidden custom
  message.

An extension can refuse a hold for its session through `RUN_HOLD_EVENT` on its
`pi.events` bus. ext-prewalk refuses while it is active.

## Alternatives considered

- Return `{ action: 'end' }` from `finishTurn` at the hold. Rejected because Pi
  then treats the run as finished: `agent_before_settle` handlers run, and
  ext-prewalk can start a completion check, which makes another model request
  during the hold. Dynamic thinking also reports its savings for an unfinished
  run.
- Continue with `agent.continue()` from the tool result. Rejected because
  `AgentSession` exposes no public path for it. Calling the agent directly skips
  `before_agent_start`, so per-run system prompt sections such as a subagent's
  instructions would be dropped from the next request.
- Write queued steering into the transcript before holding, as the design
  sketched. Rejected because it delivers follow-ups before the model would
  otherwise stop. The record re-queues each message with its kind and origin.
- Cut the model response that is still streaming. Rejected by the issue's first
  decision; it pays for that response twice.

## Consequences

- A normal step pays one call that returns `false` in the wrapped `finishTurn`,
  and one comparison per tool call in the wrapped `afterToolCall`. It adds no
  runtime call, no storage write and no model request.
- A continued run gets one hidden message (`felan-daemon-run-continued`) in its
  transcript and model context.
- Only user messages are carried across. Custom notices queued by extensions
  are delivered again by their owners: subagent completions from the daemon's
  execution records, background-bash notices from the job store.
- A run that keeps answering without tool calls never waits at a step end, so a
  hold during it waits until the run ends or `stepTimeoutMs` cancels it.
- A run waiting for a person's answer never reaches its step end during the
  hold, so the attempt is cancelled after `stepTimeoutMs`. Deferring such
  questions at hold time is not done.
- ext-context clears its loaded nested instructions at `session_start`, so a
  continued run lacks them until it reads a file in that directory again, as an
  idle session does after a restore.
- A run that an extension starts while the daemon is held, such as for a
  background command's finish notice, gets its record when it reaches a step
  end. If the stop arrives before that, the run is interrupted, as before.
- Queued but unstarted subagents are still cancelled with `host_shutdown` at
  restart.
