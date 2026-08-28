# Getting started

This guide gets Felan's local, model-portable coding agent running in an
existing project. No Felan account is required.

## Requirements

- Node.js 22.19.0 or newer
- a supported model-provider account or API credential
- macOS, Linux, or another environment supported by Felan's Node.js and Pi
  dependencies

Repository development and CI use Node.js 22.20.0 and pnpm 9.15.5. The pinned
development version is not the minimum supported runtime version.

## Install or run directly

Run the published package without a global installation:

```sh
npx @felan-ai/felan
```

Or install the `felan` command:

```sh
npm install --global @felan-ai/felan
felan
```

Felan stores local credentials, settings, sessions, and agent state under
`~/.felan`. Set `FELAN_AGENT_DIR` before launching Felan to use another
directory.

## Connect a model

Start Felan in the project you want it to inspect:

```sh
cd path/to/project
felan
```

Inside the TUI, run:

```text
/login
/logout
```

Use `/login` to add a provider and `/logout` to remove a stored provider
credential. Provider credentials stay with the local host; a felan.ai account
is not required for the terminal application.

## Run the first task

Enter a prompt in the editor, or supply the initial message on the command
line:

```sh
felan "inspect this project and explain how to run its tests"
```

Without `--mode`, supplying a message starts the interactive TUI with that
message. For automation, use the one-shot text or JSONL modes:

```sh
felan --mode text "inspect this project and explain how to run its tests"
felan --mode json --provider openai --model gpt-5.5 --thinking high "run the tests"
```

Text mode prints the final response. JSON mode emits Pi-compatible JSONL events
on stdout and keeps diagnostics on stderr. Both modes require a prompt and can
continue the most recent session with `--continue`; `--resume` remains an
interactive picker.

For implementation work, Felan can split work among asynchronous subagents,
track it in a shared dependency graph, and use Prewalk to hand the same session
from a planner model to a configured implementation model. The agent asks
structured questions when a decision requires you.

## Continue a session

Continue the most recent session for the current directory:

```sh
felan --continue
```

Sessions are selected relative to the launch directory. Run Felan from the
same project when continuing project work.

## First-start dependency choices

Some built-ins need an external executable. In interactive startup Felan may
offer to install a reviewed dependency or disable the affected extension:

- MarkItDown for office-document conversion;
- RTK for command rewriting (output compaction still works without it);
- `agent-browser` for browser automation; and
- POSIX process utilities for detached background Bash, which Felan does not
  install.

Installation is never started by a model tool call. Revisit these choices with
`/dependencies`. See [runtime dependencies](reference/runtime-dependencies.md)
for the exact versions and unavailable behavior.

## Understand the permission boundary

> [!IMPORTANT]
> The local agent runs with your user's filesystem and process permissions. It
> is a host application, not a sandbox.

Felan narrows ambient configuration and applies explicit boundaries around web,
MCP, browser, document, and credential workflows, but those controls do not
sandbox ordinary shell commands. Use an isolated environment when the project
or commands are untrusted.

Read [Runtime and security](concepts/runtime-and-security.md) before using Felan
with sensitive repositories or external systems.

## Next steps

- Learn the [local CLI](user-guide/local-cli.md).
- Understand [efficient execution and savings](concepts/efficient-execution.md).
- Review [commands and shortcuts](user-guide/commands-and-shortcuts.md).
- Configure [agents, tasks, and Prewalk](user-guide/agents-tasks-and-prewalk.md).
- Understand [context and memory](user-guide/context-and-memory.md).
- Set up [web research, MCP, browser, and document access](user-guide/web-mcp-and-browser.md).
