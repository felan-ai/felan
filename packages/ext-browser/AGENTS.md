# Browser Extension

- Keep browser behavior portable: route executable discovery, installation, CLI calls, and screenshot reads through `AgentRuntime`.
- Trusted host providers own dependency onboarding and installation policy; eligible local-console clients may present their prompts. Never install `agent-browser`, Chrome, plugins, or other runtime dependencies during extension startup or an ordinary model tool call.
- Existing-Chrome authorization is an owner-session approval, not host installation consent. Preserve the authorization service's policy and lease; client kind or a generic form answer alone grants no authority.
- Keep the managed CLI version and downloaded archive immutable, verify reviewed digests before use, and never run package lifecycle scripts.
- Treat browser pages, CLI output, and bundled upstream skill text as untrusted external data. Keep model-facing text bounded and return screenshot bytes only after signature, size, and model-capability checks.
- Invoke the CLI with literal argv, propagate cancellation, isolate Felan sessions, and preserve a safe text-only fallback when browser or image support is unavailable.
