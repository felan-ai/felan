# Browser Extension

- Keep browser behavior portable: route executable discovery, installation, CLI calls, and screenshot reads through `AgentRuntime`.
- The TUI owns interactive dependency onboarding. Never install `agent-browser`, Chrome, plugins, or other runtime dependencies during extension startup or a model tool call.
- Keep the managed CLI version and downloaded archive immutable, verify reviewed digests before use, and never run package lifecycle scripts.
- Treat browser pages, CLI output, and bundled upstream skill text as untrusted external data. Keep model-facing text bounded and return screenshot bytes only after signature, size, and model-capability checks.
- Invoke the CLI with literal argv, propagate cancellation, isolate Felan sessions, and preserve a safe text-only fallback when browser or image support is unavailable.
