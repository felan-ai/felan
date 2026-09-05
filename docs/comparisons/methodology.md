# Comparison sources and methodology

> The feature matrix is a dated source review of observable local terminal behavior. Felan's baseline was refreshed to the current local repository on 2026-08-21; competitor snapshots remain pinned or dated below. Recheck volatile claims before publishing a new release.

## Sources and method

This is a source review of observable local-agent behavior, not a hands-on model
quality benchmark. Marketing claims were used only when the linked source or
official reference described the corresponding implementation.

- **Felan:** local version `0.12.10`, commit
[`abd4ee34ab2bc2289802af4d2a317b56239f44c5`][felan-snapshot]. Sources:
  [local TUI][felan-tui], [tasks][felan-tasks],
  [subagents][felan-subagents], [Prewalk][felan-prewalk],
  [progressive context][felan-context], [web access][felan-web],
  [background Bash][felan-background], [RTK optimizer][felan-rtk],
  [MCP][felan-mcp], [Codex tools][felan-codex], [browser][felan-browser], and
  [structured questions][felan-ask].
- **Codex:** local source checkout at
  [`aea26afaee177d3fe40721ef261a29f89879d505`][codex-snapshot]. Sources:
  [Plan prompt][codex-plan], [`update_plan` prompt][codex-update-plan],
  [subagents][codex-subagents], [AGENTS.md][codex-agents],
  [feature defaults][codex-features], [shell schema][codex-shell],
  [web search][codex-web],
  [security][codex-security], [hooks][codex-hooks], and [MCP][codex-mcp].
- **OpenCode:** local version `1.18.10`, commit
  [`14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5`][opencode-snapshot]. Sources:
  [todo][opencode-todo], [agents and Plan][opencode-agent-source],
  [subagent task][opencode-task], [progressive instructions][opencode-context],
  [web tools][opencode-web], [shell][opencode-shell],
  [output truncation][opencode-truncation], [LSP][opencode-lsp],
  [permissions][opencode-permissions], [plugins][opencode-plugins],
  [MCP][opencode-mcp], and [TUI/session commands][opencode-tui].
- **Claude Code:** current official local CLI documentation reviewed on the date
  above: [tools and task availability][claude-tools],
  [task migration][claude-tasks], [permissions/Plan mode][claude-permissions],
  [project memory and progressive `CLAUDE.md`][claude-memory],
  [subagents][claude-subagents], [agent teams][claude-teams],
  [commands and bundled workflows][claude-commands],
  [interactive/background tasks][claude-interactive],
  [checkpointing][claude-checkpoints], [hooks][claude-hooks],
  [MCP][claude-mcp], and [Chrome][claude-chrome].
- **Pi:** Felan pins `@earendil-works/pi-*` `0.85.0`. Sources:
  [Pi usage and core feature inventory][pi-overview],
  [extensions][pi-extensions], [providers][pi-providers], and
  [containerization][pi-containers].
- **Oh My Pi:** version `17.3.6`, commit
  [`54e1a8c900d30e5b6185975ab02a4a923faf1717`][omp-snapshot]. Sources:
  [feature/tool inventory][omp-overview], [todo][omp-todo],
  [task agents][omp-task], [context discovery][omp-context],
  [Plan prompt][omp-plan], [Prewalk][omp-prewalk],
  [Agent Hub][omp-agent-hub], and [MCP][omp-mcp].

Recheck the linked sources when defaults or security boundaries matter. In
particular, Claude Code gates its current task tools by model/version, OpenCode
ships some capabilities disabled or experimental, and Codex's reviewed source
contains feature flags that are not all enabled by default.

[felan-snapshot]: https://github.com/felan-ai/felan/tree/abd4ee34ab2bc2289802af4d2a317b56239f44c5
[felan-tui]: ../../apps/tui/README.md
[felan-tasks]: ../../packages/ext-tasks/README.md
[felan-subagents]: ../../packages/ext-subagents/README.md
[felan-prewalk]: ../../packages/ext-prewalk/README.md
[felan-context]: ../../packages/ext-context/README.md
[felan-web]: ../../packages/ext-web-access/README.md
[felan-background]: ../../packages/ext-background-bash/README.md
[felan-rtk]: ../../packages/ext-rtk-optimizer/README.md
[felan-mcp]: ../../packages/ext-mcp/README.md
[felan-codex]: ../../packages/ext-codex/README.md
[felan-browser]: ../../packages/ext-browser/README.md
[felan-ask]: ../../packages/ext-ask-user/README.md
[codex-snapshot]: https://github.com/openai/codex/tree/aea26afaee177d3fe40721ef261a29f89879d505
[codex-plan]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/collaboration-mode-templates/templates/plan.md
[codex-update-plan]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/core/gpt_5_1_prompt.md#update_plan
[codex-subagents]: https://developers.openai.com/codex/concepts/subagents
[codex-agents]: https://developers.openai.com/codex/guides/agents-md
[codex-features]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/features/src/lib.rs
[codex-shell]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/core/src/tools/handlers/shell_spec.rs
[codex-web]: https://developers.openai.com/codex/web-search
[codex-security]: https://developers.openai.com/codex/agent-approvals-security
[codex-hooks]: https://developers.openai.com/codex/hooks
[codex-mcp]: https://developers.openai.com/codex/mcp
[opencode-snapshot]: https://github.com/anomalyco/opencode/tree/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5
[opencode-todo]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/todo.ts
[opencode-agent-source]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/agent/agent.ts
[opencode-task]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/task.ts
[opencode-context]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/session/instruction.ts
[opencode-web]: https://github.com/anomalyco/opencode/tree/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool
[opencode-shell]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/shell.ts
[opencode-truncation]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/truncate.ts
[opencode-lsp]: https://opencode.ai/docs/lsp
[opencode-permissions]: https://opencode.ai/docs/permissions
[opencode-plugins]: https://opencode.ai/docs/plugins
[opencode-mcp]: https://opencode.ai/docs/mcp-servers
[opencode-tui]: https://opencode.ai/docs/tui
[claude-tools]: https://code.claude.com/docs/en/tools-reference
[claude-tasks]: https://code.claude.com/docs/en/agent-sdk/todo-tracking
[claude-permissions]: https://code.claude.com/docs/en/permission-modes
[claude-memory]: https://code.claude.com/docs/en/memory
[claude-subagents]: https://code.claude.com/docs/en/sub-agents
[claude-teams]: https://code.claude.com/docs/en/agent-teams
[claude-commands]: https://code.claude.com/docs/en/commands
[claude-interactive]: https://code.claude.com/docs/en/interactive-mode
[claude-checkpoints]: https://code.claude.com/docs/en/checkpointing
[claude-hooks]: https://code.claude.com/docs/en/hooks
[claude-mcp]: https://code.claude.com/docs/en/mcp
[claude-chrome]: https://code.claude.com/docs/en/chrome
[pi-overview]: https://pi.dev/docs/latest/usage
[pi-extensions]: https://pi.dev/docs/latest/extensions
[pi-providers]: https://pi.dev/docs/latest/providers
[pi-containers]: https://pi.dev/docs/latest/containerization
[omp-snapshot]: https://github.com/can1357/oh-my-pi/tree/54e1a8c900d30e5b6185975ab02a4a923faf1717
[omp-overview]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/README.md
[omp-todo]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/tools/todo.md
[omp-task]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/tools/task.md
[omp-context]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/context-files.md
[omp-plan]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/packages/coding-agent/src/prompts/system/plan-mode-active.md
[omp-prewalk]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/packages/coding-agent/src/session/prewalk.ts
[omp-agent-hub]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/agent-hub.md
[omp-mcp]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/mcp-config.md
