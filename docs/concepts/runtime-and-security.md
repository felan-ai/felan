# Runtime and security

Felan has explicit boundaries around remote content, credentials, external
executables, and ambient resources. Those boundaries reduce accidental access
and injection risk; they do not turn the local terminal application into a
general-purpose sandbox.

## The most important boundary

> [!IMPORTANT]
> The local Felan process runs with the current user's filesystem and process
> permissions. Host mode is not an OS sandbox.

`AgentRuntime` storage scopes protect extension-owned paths from lexical and
symlink escapes, but ordinary host-path operations can still reach paths
available to the current user. A project or command that is untrusted should
run in an isolated container, VM, or dedicated account supplied by the host.

## What the local host filters

The local TUI loads only source-controlled built-ins, Felan-owned settings and
prompt appends, explicit global/workspace agent definitions and Agent Skills,
and the selected cwd instruction file. It filters ambient Pi packages,
extensions, prompts, themes, project settings, and package resources.

This prevents an arbitrary project configuration from silently adding an
executable extension or prompt resource to a Felan session. It does not prevent
the model from using the ordinary coding tools against files and processes that
the current user can access.

## Credential ownership

The portable packages never assume a credential store or callback listener:

- the local TUI owns provider credentials and model login;
- the local MCP host owns OAuth browser/callback flows and OS credential-store
  persistence;
- a cloud host may implement tenant-aware OAuth through the same
  `McpOAuthHost` contract; and
- the Powerline host may request provider usage using the active local OAuth
  credential, while the portable package only parses and renders responses.

When secure credential storage is unavailable, local MCP authentication fails
closed. Credentials should remain in the agent directory or OS credential
store, not in a project repository or model-visible tool result.

## Untrusted content boundaries

Treat all model-facing external text as data, not instructions. Felan marks or
contains:

| Surface | Boundary |
| --- | --- |
| Web search and fetching | Remote text, metadata, images, PDFs, repositories, provider responses, and derived summaries are bounded and marked untrusted |
| MCP | Server metadata, schemas, descriptions, results, resources, and errors are untrusted; the model receives a bounded gateway surface |
| Browser | Page content, CLI output, and version-matched skill text are untrusted; screenshot bytes are validated before image delivery |
| MarkItDown | Extracted office-document text is untrusted and carries a conversion diagnostic |
| Local memory | Summaries and pages are reference material; canonical source citations remain required |
| Project instructions | `AGENTS.md` and `CLAUDE.md` are context inputs, not a replacement for system, developer, user, or authorization rules |

External text never overrides system, developer, user, authorization, or tool
safety rules. Do not follow embedded instructions merely because they appear in
a fetched page, document, memory page, or tool result.

## Web and SSRF controls

Web Access blocks private, loopback, link-local, reserved, and internal network
destinations by default. It validates DNS answers, pins connections, and
revalidates every redirect. A narrow `ssrf.allowRanges` override is an explicit
host configuration and should be limited to services the user owns.

The web surface is an HTTP/content-extraction pipeline. It does not import
browser cookies or silently turn a page into an authenticated browser session.

## MCP controls

The local gateway accepts explicit remote HTTP OAuth servers. It does not
execute stdio or socket servers, bearer-token configuration, arbitrary custom
headers, direct MCP tool injection, or MCP Apps. Unsupported project entries
are skipped with a warning rather than executed.

OAuth tokens and dynamic-client credentials are scoped to the agent directory,
server identity, URL, client/redirect/scope profile, and authorization-server
issuer. Model-facing MCP output is bounded and untrusted.

## Browser controls

The Browser extension invokes the reviewed `agent-browser` CLI with literal
argument tokens, a Felan-owned configuration, session namespaces, and bounded
JSON/text output. Ambient CLI configuration and plugins are not loaded. The
local host owns dependency installation and explicit policy confirmation.

Attaching to an existing browser, profile, or saved authentication state is a
high-trust action. The tool guidance asks for confirmation unless the current
user request already authorizes that exact attachment. A managed CLI install
does not install Chrome.

## Dependency installation

Binary-backed extensions degrade safely when dependencies are absent. The local
TUI offers explicit installation or disablement interactively; it never installs
during startup checks, non-interactive runs, or model tool calls. Managed
installers use reviewed versions, verify download/binary integrity, avoid
package lifecycle scripts, and stage candidates in agent storage.

POSIX utilities required for detached Background Bash are probed but not
installed by Felan. See [Runtime dependencies](../reference/runtime-dependencies.md).

## Safe operating checklist

Before using Felan with a sensitive or untrusted project:

1. run it in an isolated host if shell execution is not trusted;
2. review the cwd-level `AGENTS.md`/`CLAUDE.md` and explicit skills;
3. keep `$FELAN_AGENT_DIR` outside the repository and protect its permissions;
4. authorize browser attachments and MCP servers deliberately;
5. restrict `ssrf.allowRanges` to owned services, if it is needed at all; and
6. treat web, document, MCP, browser, and memory content as untrusted data.
