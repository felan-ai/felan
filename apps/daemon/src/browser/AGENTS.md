# Local Chrome authorization

- This host boundary intentionally uses Node filesystem metadata APIs for bounded reads of `DevToolsActivePort` and the debugging preferences in `Local State`, and Node HTTP/socket APIs for the one-use connection lease. `AgentRuntime` does not expose file ownership or inbound socket lifecycles.
- Run subprocess inspection through `AgentRuntime` with literal arguments, cancellation and output limits. Native browser CLI execution stays in `ext-browser`.
- Never read cookie databases, saved credentials or profile contents beyond the fixed setup metadata. Never expose setup-file contents, endpoint material or unrelated tab data.
- A lease may make one upstream connection only. Cancellation and revocation must remove transport authority independently of daemon cleanup. Tests use injected metadata or fake loopback peers, never personal Chrome.
