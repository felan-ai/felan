# Runtime dependencies

Felan treats an executable as an extension runtime dependency only when the
extension's primary capability cannot operate without it. The extension owns
portable detection, optional installation, and safe unavailable behavior;
`apps/tui` owns interactive onboarding and global enable/disable choices.

## Lifecycle

1. Cloud and other non-interactive runtimes preinstall required executables in
   the tool-execution environment. Extensions probe that same `AgentRuntime`.
2. An unavailable dependency disables only the behavior that needs it. It must
   not trigger installation, repeatedly execute a missing command, or break
   unrelated extension behavior.
3. The local TUI's source-controlled registry in
   `apps/tui/src/dependencies.ts` checks enabled binary-backed extensions during
   interactive startup. Unresolved dependencies open a first-run
   install-or-disable dialog.
4. Install actions require explicit confirmation. Decisions are stored in
   `$FELAN_AGENT_DIR/settings.json` and can be revisited with `/dependencies`.
5. Installers use `AgentRuntime`, pin reviewed versions and installer content,
   stage temporary files in runtime storage, verify downloads, and return clear
   diagnostics. They never run during startup checks or model tool calls.

## Current dependencies

| Extension behavior | Executable | Unavailable behavior | Local install |
| --- | --- | --- | --- |
| MarkItDown document conversion | `markitdown` 0.1.7 | Read interception is bypassed; the extension can be disabled globally | Managed Python virtual environment |
| RTK command rewriting | compatible `rtk` | Rewriting is bypassed; binary-independent output compaction remains active | Digest-verified official installer pinned to RTK 0.45.0 on Linux/macOS |
| Browser automation and screenshots | `agent-browser` 0.31.1 | The browser tool is unavailable; the extension can be disabled | Integrity-verified native CLI package in Felan agent storage; Chrome is installed separately by an explicit agent-browser action |
| Background Bash detached processes | POSIX shell plus `sh`, `nohup`, `ps`, `tr`, `kill`, `date`, `cat`, and `mv` | Background Bash tools remain inactive | No managed installer; use a compatible runtime |

Other process calls are not whole-extension startup dependencies. `git` in web
repository extraction and the powerline is optional per operation; credential
shell commands are explicitly configured by the user; Chrome installation is a
separate explicit browser action; and `rg` is a core runtime prerequisite
managed by Pi in the local TUI. Those paths report or suppress their own
operation-level errors instead of disabling otherwise usable extensions.

When adding another binary-backed extension, add its detector and explicit
installer (if one can be made safe) to the owning package, register it in the
TUI dependency registry, test interactive and headless behavior, and document
the cloud image requirement.
