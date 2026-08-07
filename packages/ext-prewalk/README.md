# @felan-ai/ext-prewalk

Same-session Prewalk for Felan: the current model explores and plans the work in the session task graph, then makes one focused mutation. Felan switches the next model request to the `low` model tier, which finishes and verifies the task with the full conversation and tool history intact. Tier resolution prefers the planner's provider and model family before falling back to another authenticated provider.

After the run settles, Prewalk restores the original planner model and thinking level by default.

## Requirements

- An authenticated model in the configured target tier, or an authenticated exact target model
- At least one explicit mutation tool: Pi's `edit` or `write`, or the Codex extension's `apply_patch`

Prewalk refuses to arm when no explicit mutation tool is active. Shell tools such as `bash` and Codex `exec_command` do not qualify because they are also used for exploration and verification. The planning and verification prompts direct the models to use the Tasks workflow, but Prewalk does not inspect task activity at runtime.

## Commands

```text
/prewalk <task>  Arm Prewalk and start the task immediately
/prewalk         Arm Prewalk for the next ordinary prompt
/prewalk status  Show the phase, target model, and restoration setting
/prewalk off     Cancel Prewalk
```

`status` and `off` are handled locally and do not make a provider request. In TUI mode, an inline task is submitted as a user message. In JSON and print modes, it is submitted as a visible custom message and the command waits for the run to become idle. Turning Prewalk off after handoff restores the original planner when restoration is enabled. A manual model selection cancels Prewalk and keeps the model selected by the user.

## Lifecycle

1. The planner explores the relevant repository surface and determines the complete implementation scope.
2. The planner creates outcome-oriented implementation and validation tasks with `TaskCreate`, links them with `blocked_by` dependencies that encode the execution order, and claims the first ready task with `TaskUpdate`.
3. The planner performs one focused successful `edit`, `write`, or `apply_patch`.
4. At that turn boundary, Felan resolves and switches to the configured target tier or exact model.
5. The target model completes the existing session task graph and runs the relevant verification.
6. Once the agent run has fully settled, Felan restores the planner model and thinking level.

A successful mutation qualifies the turn for handoff regardless of Tasks activity. Failed mutation calls do not qualify. If the planner stops after prose or partial tool progress, Prewalk can queue a bounded hidden continuation, with a maximum of three per run.

The handoff does not fork, summarize, or replace the session. Planning guidance and implementation guidance are transient context messages; user messages, assistant responses, task-tracking results, mutations, and verification results remain in one trajectory.

The extension also registers concise static `prewalk` capability guidance
during initialization. Phase-specific planning and implementation instructions
remain transient context messages.

## Flags

Prewalk uses Pi's namespaced extension flags and does not read a configuration file.

```text
--prewalk-target-model <high|medium|low|provider/model-id>
--prewalk-restore-planner
--no-prewalk-restore-planner
```

`prewalk-target-model` defaults to `low`. Tier selection uses the authenticated models allowed by the current session, preferring the planner's provider and model family. An exact `provider/model-id` overrides tier selection. `prewalk-restore-planner` defaults to `true`.

## Failure behavior

- A target tier with no authenticated candidate, or a missing exact target model or authentication, clears the handoff and keeps the existing trajectory.
- A failed target-model switch clears Prewalk and reports the failure once.
- A failed planner restoration clears Prewalk, reports the failure once, and keeps the current model.
- A manual model change cancels Prewalk without restoring over the user's selection.
- Session quit, reload, replacement, or fork while the target is active attempts planner restoration as a graceful shutdown backstop.
- Reaching the automatic continuation limit lets the run settle normally.

## Development

Source: `packages/ext-prewalk` in <https://github.com/felan-ai/felan>.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @felan-ai/ext-prewalk build
pnpm --filter @felan-ai/ext-prewalk test
```

## Attribution

This package adapts the MIT-licensed `packages/pi-prewalk` implementation from `mslavov/pi-extensions` at commit `7e72e509fe45a5a87c4c2e176cb711de994a8c1d`. See [NOTICE](./NOTICE) and [LICENSE](./LICENSE).
