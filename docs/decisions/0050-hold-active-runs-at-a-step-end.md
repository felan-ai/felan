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
ID, the transcript leaf, the queued user messages and, for a subagent, the turns
it has taken including the held step. It goes to its own `held_runs` table in
the control store. Then the daemon answers `held`.

- A hold refuses at once with `busy` when a question waits for a person or a
  live process runs. Neither ends by itself, so waiting for them would keep
  admission closed until `stepTimeoutMs`. A question that appears during the
  wait, or a live process left once every run waits, cancels the attempt at
  once.
- A hold answers `busy` while the daemon still continues the runs its
  predecessor held, because closing admission then would interrupt them. It
  answers `busy` too, idle holds included, while the daemon restores at
  startup the sessions whose background jobs may still run or still owe a
  finish notice, because a closed admission stops that restore.
- A cancelled or expired hold deletes the records and releases each waiting
  step with its original decision, so the run continues in place as if it had
  only paused. The steps are released even if the delete fails. Subagents that
  were queued while admission was closed start then.
- While runs are held, a subagent completion reaches its parent only when the
  parent is resident and idle. It starts a run there, which the hold waits for
  or holds like any other. A busy parent gets the completion once the hold ends
  or from the next daemon, because a run that a restart ends would drop a
  queued notice.
- A stop after `held` does not wait for held runs. A run that starts after
  `held`, such as for a background command's finish notice, gets its record
  when it reaches a step end, including during the stop's drain. If that
  record cannot be written, the run takes its next step instead. A completion
  the daemon can still deliver to an idle parent, in flight or owed, keeps the
  drain waiting even in a root with a held run, so the run it starts holds
  too. The stop then aborts the waiting runs. An abort releases the hook with
  `{ action: 'end' }`, so the run ends without another request and without an
  aborted message. Their runs stay `running` and their child executions stay
  unfinished.
- Ending the run makes Pi append what it kept for the step's end, such as
  context-only custom messages. When only such context or metadata follows the
  recorded leaf, the record moves to the final leaf as the session is evicted.
- The next daemon consumes the records at startup. It restores each session
  whose run and transcript leaf still match, with its parent sessions, and
  re-queues the saved messages. It starts the next step through Pi's normal
  run start with a hidden custom message of type `felan-daemon-run-continued`.
  Its text is: "Notice from the session host, not from the user: the host
  restarted after the tool results above were saved. Continue the task from
  where you stopped." When a subagent's next step is its last, its tools are
  removed and the summary instruction is queued after the saved messages, as
  the held step's `turn_end` would have done. When the held step used its last
  turn, the subagent ends with `turn_limit_reached` and takes no step.
- A record that does not match, or a continued run whose next step fails,
  leaves the run `interrupted`. A subagent whose run cannot continue finishes
  as `cancelled` with `host_shutdown`, and its parent is told.

An extension can refuse a hold for its session through `RUN_HOLD_EVENT` on its
`pi.events` bus. ext-prewalk refuses while it is active, and ext-codex refuses
while it owes the run a deferred compaction.

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
- Defer every subagent completion while runs are held and let the next daemon
  deliver it. Rejected because the next daemon delivers a completion only when
  its parent is restored, and an idle parent root is restored only when a
  client opens it.
- Refuse to hold a step while Pi still has context-only messages to append.
  Rejected because a message can also arrive while the step waits; moving the
  leaf after the stop covers both.

## Consequences

- A normal step pays one call that returns `false` in the wrapped `finishTurn`,
  and one comparison per tool call in the wrapped `afterToolCall`. A subagent
  also pays one `Map` lookup per `turn_end` to skip a held step's count.
  ext-background-bash runs a handler on every `message_start`, `message_end`
  and `agent_end`, which returns after a type check or a loop over an empty
  set. A normal step adds no runtime call, no storage write and no model
  request.
- `host.status` observes live processes twice: once to count interruptible
  work and once for the `blocking` count. While a hold waits, each check reads
  activity and the process counts again, on every park and at least every
  100 ms.
- A continued run gets one hidden message in its transcript and model context.
  The model reads it as a user turn, so it names its sender.
- Only user messages are carried across. A custom message an extension steers
  into a held run waits in Pi's queue, and the stop that ends the run drops
  it. Its owner delivers it again only if the owner marks it delivered after Pi
  stores it. The daemon keeps a subagent completion pending until the parent
  port finds its entry in the transcript. ext-background-bash settles a finish
  notice on the first `message_start` or `agent_end` after its `message_end`,
  which Pi emits once it has appended the entry. An extension that marks a
  steer delivered when it sends it loses that steer at a restart. The other
  bundled extensions that send custom messages use `triggerTurn: false`
  (ext-memory, ext-fusion) or send them only while they refuse holds
  (ext-prewalk).
- A run that keeps answering without tool calls never waits at a step end, so a
  hold during it waits until the run ends or `stepTimeoutMs` cancels it.
- A run started after `held` that has not reached a step end when a force stop
  arrives is interrupted. A drain stop waits for it to reach one.
- Subagents that are queued but not started cannot start while a hold keeps
  admission closed. A restart cancels them with `host_shutdown`.
- A continued run starts from a custom message, so state that extensions build
  only when a run starts from a user message, or keep only in memory, is lost:
  - ext-subagents adds its routing guidance only to a run that starts from a
    user message, so the remaining steps of a continued run go without it.
  - Dynamic thinking does not classify the continued step and reports no
    savings for a held run.
  - ext-context clears its loaded nested instructions at `session_start`, so a
    continued run lacks them until it reads a file in that directory again, as
    an idle session does after a restore.
  - ext-prewalk and ext-codex keep their state in memory too, which is why they
    refuse holds while that state matters.
