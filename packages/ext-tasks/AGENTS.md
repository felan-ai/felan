# Tasks Extension

- Own the root-session task graph, task tools, dependency validation, task presentation, and session-scoped persistence.
- Route persistence through `AgentRuntime.storage('session')`; every root session and its subagents share one graph.
- Keep task execution outside this package. Agents claim tasks through `TaskUpdate` and may delegate with any available agent mechanism.
- Serialize mutations per storage root within one host process and keep the extension independent from `@felan-ai/ext-subagents`.
