# Run Extension

- Keep generated code inside the Run SDK QuickJS boundary. Never add a module loader, ambient credentials, filesystem access, or network access to the guest.
- Nested tools are selected from the active session and invoked through Agent Core's `FelanToolInvoker`; do not call raw tool definitions.
- Default access is read-only and bounded. Risky tools require exact explicit configuration and `run_code`, Prewalk, and lifecycle controls remain unavailable.
- Bound source, host arguments/results, calls, concurrency, and final output. Treat all guest source and nested results as untrusted.
