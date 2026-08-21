# @felan-ai/ext-prewalk

Same-session Prewalk for Felan: the current model explores and plans the work in the session task graph, then makes one focused mutation. Felan switches the next model request to the `low` model tier, which finishes and verifies the task with the full conversation and tool history intact. Tier resolution prefers the planner's provider and model family before falling back to another authenticated provider.

After the run settles, Prewalk restores the original planner model and thinking level by default.

For ordinary file-changing requests, the model can enter Prewalk itself by calling `enter_prewalk` before it explores or mutates the repository. `/prewalk` remains available when the user wants to enter explicitly. Read-only requests do not use Prewalk.

## Requirements

- An authenticated model in the configured target tier, or an authenticated exact target model
- At least one explicit mutation tool: Pi's `edit` or `write`, or the Codex extension's `apply_patch`

Prewalk refuses to arm when no explicit mutation tool is active. Shell tools such as `bash` and Codex `exec_command` do not qualify because they are also used for exploration and verification. The planning and verification prompts direct the models to use the Tasks workflow, but Prewalk does not inspect task activity at runtime.

## Commands

```text
/prewalk <task>  Arm Prewalk and start the task immediately
/prewalk         Arm Prewalk for the next ordinary prompt
/prewalk status  Show the phase, target model, and restoration setting
/prewalk exit    Exit Prewalk
/prewalk off     Alias for exit
/prewalk cancel  Alias for exit
```

`status`, `exit`, `off`, and `cancel` are handled locally and do not make a provider request. In TUI mode, an inline task is submitted as a user message. In JSON and print modes, it is submitted as a visible custom message and the command waits for the run to become idle. Exiting during planning cancels the pending handoff immediately. Exiting while the target model is actively running defers planner restoration until that run settles; it does not abort the current provider request or the underlying task. A manual model selection cancels Prewalk and keeps the model selected by the user.

## Model entry tool

```text
enter_prewalk {}  Enter Prewalk for the current file-changing task
```

The no-argument tool transitions the current run directly into planning, so it works while the agent is active. It must be called once, by itself, before repository exploration or mutation. A mutation in the same model turn as the entry call cannot trigger handoff; the planning guidance must reach a later model turn first.

The successful entry call and result are orchestration controls. They remain in the stored session transcript but are removed from model context, along with phase guidance, so the target receives the useful exploration, task graph, and first valid change rather than an instruction to keep planning.

## Lifecycle

1. The planner explores the relevant repository surface and determines the complete implementation scope.
2. The planner creates a concise graph of at most nine outcome-oriented tasks with `TaskCreate`, includes concrete validation in their acceptance criteria, links them with `blocked_by` dependencies that encode the execution order, and claims the first ready task with `TaskUpdate`.
3. The planner performs one focused successful `edit`, `write`, or `apply_patch`.
4. At that turn boundary, Felan resolves and switches to the configured target tier or exact model.
5. The target model completes the existing session task graph and runs the relevant verification.
6. Once the agent run has fully settled, Felan restores the planner model and thinking level.

A successful mutation qualifies the turn for handoff regardless of Tasks activity. Failed mutation calls do not qualify. If the planner stops after prose or partial tool progress, Prewalk can queue a bounded hidden continuation, with a maximum of three per run.

The handoff does not fork, summarize, or replace the session. Planning guidance and implementation guidance are transient context messages; user messages, assistant responses, task-tracking results, mutations, and verification results remain in one trajectory.

This follows the [Prewalk design described by Stencil](https://stencil.so/blog/prewalk): transfer the grounded exploration, bounded work list, and first valid move rather than handing a detached plan document to a second reader.

The extension also registers concise static `prewalk` capability guidance
during initialization. Phase-specific planning and implementation instructions
remain transient context messages.

## Thinking levels

Prewalk does not force a planner or executor thinking level. It snapshots the current level, Pi carries and clamps that preference to the target model's supported levels during handoff, and Prewalk restores the planner model before restoring the exact original level. This keeps user and subagent thinking choices authoritative and avoids assuming that every low-tier executor supports or performs well at the same fixed effort.

The referenced Prewalk design requires deep planning and a cheaper executor, but does not prescribe a separate executor effort. Select the desired thinking level before starting the task; model-tier routing supplies the default cost reduction.

## Subagents

`enter_prewalk` is loaded into mutation-capable general and custom child sessions whenever Prewalk is enabled. Each child owns an independent lifecycle and snapshots its own selected model and thinking level. Child handoffs honor the root session's configured model scope. Inspection-only `explore` and `reviewer` children do not receive the entry tool because their mutation tools are intentionally disabled.

## Flags

Prewalk uses Pi's namespaced extension flags and does not read a configuration file.

```text
--prewalk-target-model <high|medium|low|provider/model-id>
--prewalk-restore-planner
--no-prewalk-restore-planner
```

`prewalk-target-model` defaults to `low`. Tier selection uses the authenticated models allowed by the current session, preferring the planner's provider and model family. An exact `provider/model-id` overrides tier selection but must remain inside a nonempty session model scope. `prewalk-restore-planner` defaults to `true`.

## Failure behavior

- A target tier with no authenticated candidate, or a missing exact target model or authentication, clears the handoff and keeps the existing trajectory.
- An exact target outside a nonempty session model scope is rejected before switching.
- A failed target-model switch clears Prewalk and reports the failure once.
- A failed planner restoration clears Prewalk, reports the failure once, and keeps the current model.
- A manual model change cancels Prewalk without restoring over the user's selection.
- Repeated entry calls do not replace the active run or its planner snapshot.
- Exit requests during active target inference restore only after the run settles.
- Session quit, reload, replacement, or fork while the target is active attempts planner restoration as a graceful shutdown backstop.
- Reaching the automatic continuation limit lets the run settle normally.

## Attribution

This package adapts the MIT-licensed `packages/pi-prewalk` implementation from `mslavov/pi-extensions` at commit `7e72e509fe45a5a87c4c2e176cb711de994a8c1d`. See [NOTICE](./NOTICE) and [LICENSE](./LICENSE).

## Composition and package boundary

```ts
import prewalkExtension from '@felan-ai/ext-prewalk';

const extension = prewalkExtension;
```

The extension owns the same-session state machine, explicit mutation
qualification, transient planning/implementation guidance, target selection,
and restoration lifecycle. Agent Core supplies model tiers and the host supplies
authenticated model scope, session lifecycle, and active tools. Prewalk does
not inspect or execute the task graph, and it is not a sandbox or approval mode.

The package requires compatible Agent Core and Tasks peers plus an explicit
`edit`, `write`, or Codex `apply_patch` tool in the composed session.

## Development

Source: `packages/ext-prewalk` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-prewalk build
pnpm --filter @felan-ai/ext-prewalk type-check
pnpm --filter @felan-ai/ext-prewalk test
```

## Related documentation

- [Agents, tasks, and Prewalk](../../docs/user-guide/agents-tasks-and-prewalk.md)
- [Architecture](../../docs/concepts/architecture.md)
- [Extension catalog](../../docs/reference/extension-catalog.md)
