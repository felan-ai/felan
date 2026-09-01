# @felan-ai/ext-prewalk

Same-session Prewalk for Felan's complex repository work: the current model explores and plans the work in the session task graph, optionally reviews that plan with the user, then makes one focused mutation. Felan switches the next model request to the `low` model tier at exact `medium` thinking by default, which finishes and verifies the task with the full conversation and tool history intact. Tier resolution prefers the planner's provider and model family before falling back to another authenticated provider.

After the run settles, Prewalk restores the original planner model and thinking level by default. All of these automated changes are scoped to the active session and do not change the user's or project's default model or thinking preference.

When a savings reporter is available, Prewalk reports each implementation turn as a `model-routing` saving. The observed target-model usage is the actual outcome; the estimated planner-model baseline uses two thirds of each observed input, output, and cache token class (rounded to whole tokens). The host prices both outcomes and records the dollar difference as estimated savings. Planning turns, same-model handoffs, and failed or aborted turns are not reported. Savings reporting is optional and never interrupts the Prewalk lifecycle.

For complex repository work that benefits from substantial exploration, coordinated multi-file changes, dependency-aware planning, or broad verification, the model can request Prewalk by calling `enter_prewalk` for a new file-changing task. Conversation or repository activity from earlier requests does not prevent entry. The model should prefer to enter before exploring the current task; if its complexity becomes clear after read-only exploration, it can still enter before the task's first mutation. Model-requested entry asks for user approval by default. Small localized edits and routine one-file fixes should normally stay on the regular path. `/prewalk` remains available when the user wants to enter explicitly and does not ask for redundant approval. Read-only requests do not use Prewalk.

## Requirements

- An authenticated model in the configured target tier, or an authenticated exact target model
- At least one explicit mutation tool: Pi's `edit` or `write`, or the Codex extension's `apply_patch`

Prewalk refuses to arm when no explicit mutation tool is active. Shell tools such as `bash` and Codex `exec_command` do not qualify because they are also used for exploration and verification. When both `TaskCreate` and `TaskUpdate` are active, handoff also waits for successful task creation and an in-progress task claim; if those tools are unavailable, mutation-only handoff remains available. Prewalk does not inspect `TaskList`, `TaskGet`, todo, or Beads activity.

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
enter_prewalk {}  Enter Prewalk for complex repository work
```

The no-argument tool requests a transition of the current run into planning, so it works while the agent is active. With the default `ask` policy, dialog-capable hosts ask the user before entering. A denial returns a tool error that directs the model to continue normally. JSON and print modes deny `ask` rather than blocking for unavailable input. Hosts can initialize the extension with `allow` for unattended environments such as a cloud platform, or `deny` to reject model-requested entry. Use the tool for complex repository work rather than small localized edits or routine one-file fixes. It must be called once and by itself. Conversation or repository activity from earlier requests does not prevent entry. Prefer entry before exploring the current task; if its complexity becomes clear after read-only exploration, call the tool before its first mutation. A mutation in the same model turn as a successful entry call cannot trigger handoff; the planning guidance must reach a later model turn first.

The successful entry call and result are orchestration controls. They remain in the stored session transcript but are removed from model context. Current phase guidance is transient and replaced at the phase boundary, so the target receives the useful exploration, task graph, and first valid change with implementation guidance rather than an instruction to keep planning.

## Plan review

When plan review is active, the planner presents a concise numbered summary after preparing the task graph and asks the user to raise concerns by point number or explicitly approve. Discussion and revisions stay with the planner, which updates the task graph and re-presents the summary as needed. After explicit approval, the planner calls `approve_prewalk_plan`; Prewalk then allows the existing focused-mutation gate to trigger the model handoff. Mutation tools remain available during review, so the non-mutation boundary is guidance enforced rather than a security sandbox.

In modes without interactive input, an `ask` review is auto-approved after the plan is presented. Prewalk emits a warning explaining the mode-based auto-approval, then continues through the same focused-mutation handoff.

## Lifecycle

1. The planner explores the relevant repository surface and determines the complete implementation scope.
2. When the task tools are available, the planner creates a concise graph of at most nine outcome-oriented tasks with `TaskCreate`, includes concrete validation in their acceptance criteria, links them with `blocked_by` dependencies that encode the execution order, and claims the first ready task with `TaskUpdate`.
3. When plan review is active, the planner presents a concise numbered summary, discusses concerns, revises the task graph as needed, and waits for explicit approval.
4. When both task tools are active, successful `TaskCreate` and `TaskUpdate`
   calls claiming `in_progress` work open the task gate. The planner then
   performs one focused successful `edit`, `write`, or `apply_patch`.
5. At that turn boundary, Felan resolves and switches to the configured target tier or exact model.
6. The target model completes the existing session task graph and runs the relevant verification.
7. Once the agent run has fully settled, Felan restores the planner model and thinking level.

When both task tools are active, successful `TaskCreate` and `TaskUpdate` calls claiming `in_progress` work are required before a successful mutation qualifies the turn for handoff. Failed or unrelated task calls do not open that gate. If the task tools are unavailable, a successful explicit mutation qualifies directly. Failed mutation calls never qualify. If the planner stops after prose or partial tool progress, Prewalk can append a compact hidden continuation that directs the next tool action without repeating the full planning instructions. It sends at most one continuation per no-progress stretch and three per run.

The handoff does not fork, summarize, or replace the session. Planning and implementation guidance are transient context messages. Within a phase, the current guidance stays at one stable context position while assistant responses, tool results, and compact continuations append after it. At the phase boundary, Prewalk replaces that guidance once; after the run, it removes all Prewalk controls. User messages, assistant responses, task-tracking results, mutations, and verification results remain in one trajectory.

This follows the [Prewalk design described by Stencil](https://stencil.so/blog/prewalk): transfer the grounded exploration, bounded work list, and first valid move rather than handing a detached plan document to a second reader.

The extension also registers concise static `prewalk` capability guidance
during initialization. Phase-specific planning and implementation instructions
remain transient, stable-position context messages.

## Thinking levels

The planner keeps its current thinking level while exploring. The implementation
handoff requests exact `medium` thinking by default, rather than carrying a
planner's potentially expensive `max` effort to the cheaper target. The request
is clamped by Pi to the target model's supported levels, so a non-reasoning
model receives `off`. Configure another target level when the task needs a
different quality/cost balance. A same-model target with a different effective
level is still a real effort handoff; only matching model and effective effort
are a no-op. After the run settles, Prewalk restores the planner model before
restoring its exact original thinking level.

## Subagents

`enter_prewalk` is loaded into mutation-capable general and custom child sessions whenever Prewalk is enabled. Each child owns an independent lifecycle and snapshots its own selected model and thinking level. Child handoffs honor the root session's configured model scope. Inspection-only `explore` and `reviewer` children do not receive the entry tool because their mutation tools are intentionally disabled.

## Configuration

Prewalk declares typed settings. Felan exposes them through
`extensionConfig.prewalk` in `settings.json`, generated CLI options, `/settings`,
and Agent Core's programmatic configuration API.

```text
--prewalk-target-model <high|medium|low|provider/model-id>
--prewalk-target-thinking <off|low|medium|high|xhigh|max>
--prewalk-restore-planner
--no-prewalk-restore-planner
--prewalk-entry-approval <ask|allow|deny>
--prewalk-plan-review <inherit|ask|skip>
```

`targetModel` defaults to `low`, `targetThinking` defaults to exact `medium`,
`restorePlanner` defaults to `true`, `entryApproval` defaults to `ask`, and
`planReview` defaults to `inherit`. `inherit` resolves to `ask` when
`entryApproval` is `ask`, and to `skip` otherwise. An explicit `ask` reviews
every Prewalk run, including `/prewalk`; `skip` preserves the automatic planning
and focused-mutation flow.
The local CLI equivalent is `felan --prewalk-entry-approval allow`. This policy
applies only to model-called `enter_prewalk`; `/prewalk` is already explicit
user intent.

## Failure behavior

- A target tier with no authenticated candidate, or a missing exact target model or authentication, clears the handoff and keeps the existing trajectory.
- A target that already matches the active planner model and effective target thinking clears Prewalk without performing a handoff.
- A same-model target with a different effective thinking level changes effort without changing models and then enters implementation.
- An exact target outside a nonempty session model scope is rejected before switching.
- A failed target-model switch clears Prewalk and reports the failure once.
- A failed planner restoration clears Prewalk, reports the failure once, and keeps the current model.
- A manual model change cancels Prewalk without restoring over the user's selection.
- Repeated entry calls do not replace the active run or its planner snapshot.
- Plan approval calls outside an active review are rejected without changing the run.
- A successful mutation before required plan approval does not trigger handoff; Prewalk relies on planner guidance rather than disabling mutation tools.
- Exit requests during active target inference restore only after the run settles.
- Session quit, reload, replacement, or fork while the target is active attempts planner restoration as a graceful shutdown backstop.
- Reaching the automatic continuation limit lets the run settle normally.

## Attribution

This package adapts the MIT-licensed `packages/pi-prewalk` implementation from `mslavov/pi-extensions` at commit `7e72e509fe45a5a87c4c2e176cb711de994a8c1d`. See [NOTICE](./NOTICE) and [LICENSE](./LICENSE).

## Composition and package boundary

```ts
import { configureExtension } from '@felan-ai/agent-core';
import prewalkExtension, { PREWALK_CONFIG } from '@felan-ai/ext-prewalk';

const extension = prewalkExtension;
const cloudConfig = configureExtension(PREWALK_CONFIG, {
  entryApproval: 'allow',
  planReview: 'skip',
}, 'cloud runtime');
```

Pass `cloudConfig` through Agent Core's `extensionConfigOverrides` when composing
the cloud session.

The extension owns the same-session state machine, explicit mutation
qualification, stable-position transient planning/implementation guidance,
target selection, and restoration lifecycle. Agent Core supplies model tiers and the host supplies
authenticated model scope, session lifecycle, and active tools. Prewalk does not
inspect or execute the task graph beyond the successful TaskCreate/TaskUpdate
handoff gate described above. Entry approval controls only whether a model may
start Prewalk. Plan review is a conversational approval checkpoint, not a
sandbox or a tool-level mutation restriction.

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
