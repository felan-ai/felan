# Subagents Extension

- Own exactly five tools: `Agent`, `list_subagents`, `get_subagent_result`, `steer_subagent`, and `cancel_subagent`, plus agent definitions, routing, model selection, and normalized results. Providers enforce execution limits and depth at admission.
- Use the required core `SESSIONS_SERVICE` for asynchronous admission, listing, results, steering, and cancellation. Children are ordinary daemon sessions. Providers own execution lifetime, persistence, completion delivery, and shutdown; the extension must not create a separate registry.
- Result reads are non-consuming unless explicitly acknowledged. Tools must work without a navigator or custom presenter; client presentation belongs in `apps/felan`.
- Resolve model tiers through Agent Core using allowed authenticated models and current-provider preference. Reserve `xhigh` for unusually complex architecture, design, planning, debugging, and high-stakes review work.
- Discover only explicit user and workspace agent definition directories through `AgentRuntime`. Never load ambient Pi agents or extensions.
