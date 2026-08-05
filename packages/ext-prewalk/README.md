# @felan-ai/ext-prewalk

Same-session Prewalk for Felan: the current model explores and plans the work, records a validated task plan, and makes one focused mutation. Felan then switches the next model request to `openai-codex/gpt-5.6-luna`, which finishes and verifies the task with the full conversation and tool history intact.

After the run settles, Prewalk restores the original planner model and thinking level by default.

## Requirements

- An authenticated target model
- A Beads workspace with an active `bash` or `exec_command` tool, or an active `todo_write` tool
- At least one active mutation tool: `edit`, `write`, or `apply_patch`

When `/prewalk` is armed, it probes the current working directory with `bd status` through the active Felan `AgentRuntime`. A configured Beads workspace makes Beads the task tracker for that run; otherwise Prewalk uses `todo_write`. Prewalk refuses to arm and names the missing capability when the selected tracker or mutation tools are unavailable. Felan currently does not provide a global `todo_write` tool, so non-Beads workspaces require another extension to provide that capability.

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
2. The planner records implementation and validation work. It uses direct `bd` CLI commands when Beads is configured, or calls `todo_write` with 5–9 items and exactly one `in_progress` item otherwise.
3. The planner performs one focused successful `edit`, `write`, or `apply_patch` after the task-tracking gate opens.
4. At that turn boundary, Felan switches to the configured target model.
5. The target model completes the existing Beads graph or checklist and runs the relevant verification.
6. Once the agent run has fully settled, Felan restores the planner model and thinking level.

Tool-call order controls the handoff even when tools execute in parallel: a successful Beads task update or todo checklist followed by a mutation can qualify in the same turn, while a mutation before task tracking cannot. Failed tracking or mutation calls do not qualify. If the planner stops after prose or partial tool progress, Prewalk can queue a bounded hidden continuation, with a maximum of three per run.

The handoff does not fork, summarize, or replace the session. Planning guidance and implementation guidance are transient context messages; user messages, assistant responses, task-tracking results, mutations, and verification results remain in one trajectory.

The extension also registers concise static `prewalk` capability guidance
during initialization. Phase-specific planning and implementation instructions
remain transient context messages.

## Flags

Prewalk uses Pi's namespaced extension flags and does not read a configuration file.

```text
--prewalk-target-model <provider/model-id>
--prewalk-restore-planner
--no-prewalk-restore-planner
```

`prewalk-target-model` defaults to `openai-codex/gpt-5.6-luna`. `prewalk-restore-planner` defaults to `true`.

## Failure behavior

- Missing target model or authentication clears the handoff and keeps the existing trajectory.
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
