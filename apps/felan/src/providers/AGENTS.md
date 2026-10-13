# Local service providers

- These modules implement trusted local services inside the daemon's ownership boundary, not inside TUI/ACP renderers. Resolve code from the fixed managing-package installation anchor.
- Native filesystem metadata, local credential storage, process/bootstrap integration and Pi model configuration are intentional host-side I/O here. Portable feature logic belongs in extensions and continues to use `AgentRuntime`, typed services and generic UI.
- Never create an independent session registry or bypass daemon admission, storage ownership, policy, activation or drain barriers. Pass restricted operations across the provider boundary; do not expose registry internals to extensions.
- Keep provider work inactive until canonical registration. Failed cleanup retains ownership; cancelled native installers must settle before their provider is released.
- Never serialize credentials, environment values, callback verifiers or private endpoints into UI, events, command identities, configuration snapshots or diagnostics.
