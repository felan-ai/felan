# Subagents Extension

- Own the portable contracts, schemas, validation, normalized presentation, session binding, and exactly five tools: `Agent`, `list_subagents`, `get_subagent_result`, `steer_subagent`, and `cancel_subagent`.
- `SubagentHost` owns execution, admission policy, records, persistence, continuation, nesting, cancellation, and completion delivery. Application host behavior belongs in `apps/tui`.
- Launches remain asynchronous and result reads remain non-consuming snapshots. Bind the parent lifecycle before activation and preserve cleanup on session disposal.
- Keep ambient agent and extension discovery outside this package.
