# Runtime and security

Felan Code has explicit boundaries around remote content, credentials, external
executables, and ambient resources. Those boundaries reduce accidental access
and injection risk; they do not turn the local terminal application into a
general-purpose sandbox.

## The most important boundary

> [!IMPORTANT]
> The local Felan Code process runs with the current user's filesystem and process
> permissions. Host mode is not an OS sandbox.

`AgentRuntime` storage scopes protect extension-owned paths from lexical and
symlink escapes, but ordinary host-path operations can still reach paths
available to the current user. A project or command that is untrusted should
run in an isolated container, VM, or dedicated account supplied by the host.

## What the local host filters

The local host loads source-controlled built-ins, Felan-owned settings and
prompt appends, explicit global/workspace agent definitions and Agent Skills,
the selected cwd instruction file, and external extensions explicitly supplied
by local clients with `--extension`/`-e`. Remote creates cannot supply explicit
paths. The host-wide settings `piExtensions.user` and `piExtensions.project`,
both off by default, add `~/.pi/agent/extensions` and trusted
`<cwd>/.pi/extensions` to every newly created root, including ACP, headless,
web-created and imported sessions.

Only the creating TUI prompts for folder trust. Without a saved decision, ACP,
headless and web creates skip project extensions and save no decision. Folders
already trusted directly or through a parent load for every creator. Decisions
are stored in `$FELAN_AGENT_DIR/trust.json`, not Pi's trust file. Opening a
project for remote creation does not grant folder trust. The host still filters
Pi packages, prompts, project themes, skills, project settings, and package resources.
The separate `piExtensions.llamaCpp` opt-in loads only Pi's bundled llama.cpp
integration in root sessions created by any client, not children; it does not
enable other Pi built-ins or ambient discovery.
`$FELAN_AGENT_DIR/themes` is Felan user configuration, not Pi ambient discovery.
External extension paths are fixed at creation. Resume and clone/fork retain
saved paths; adopting an existing unindexed transcript loads no external
extensions. Children load the same external extension paths as their root.
Explicit and opted-in external extensions execute with the current user's
filesystem and process permissions, including in ACP, headless, web-created
and child sessions. Worker tool allowlists still limit active tools; they do
not sandbox loaded extension code.

This prevents an arbitrary project configuration from silently adding an
executable extension or prompt resource to a Felan Code session. It does not prevent
the model from using the ordinary coding tools against files and processes that
the current user can access.

## Credential ownership

The portable packages never assume a credential store or callback listener:

- the local daemon owns provider credentials, model login, and persisted settings;
- the MCP extension owns OAuth orchestration, uses Core Secrets for persistence,
  and requests local authorization through host-audience forms;
- the local provider owns only the loopback callback and secure token store;
  cloud hosts provision configuration and credentials without local sign-in; and
- the Powerline host may request provider usage using the active local OAuth
  credential, while the portable package only parses and renders responses.

When secure credential storage is unavailable, local MCP authentication fails
closed. Credentials should remain in the agent directory or OS credential
store, not in a project repository or model-visible tool result.

## Untrusted content boundaries

Treat all model-facing external text as data, not instructions. Felan Code marks or
contains:

| Surface | Boundary |
| --- | --- |
| Web search and fetching | Search metadata, fetched text/PDF passages, and provider responses are bounded and marked untrusted |
| MCP | Server metadata, schemas, descriptions, results, resources, and errors are untrusted; the model receives a bounded gateway surface |
| Browser | Page content, CLI output, and version-matched skill text are untrusted; screenshot bytes are validated before image delivery |
| Felan API | Authenticated API responses are bounded, marked untrusted, and never receive the API key in model-visible details |
| MarkItDown | Extracted office-document text is untrusted and carries a conversion diagnostic |
| Local memory | Summaries and pages are reference material; canonical source citations remain required |
| Classifier-guided local memory | Bounded, redacted excerpts of staged target transcripts may be sent to the classifier provider selected by the host from Pi's authenticated catalog; inspect and noise are advisory lossless splits, the worker can grep either and the existing wiki, original input remains staged, and publication still requires provenance validation and a fenced lease |
| Classifier-guided subagent routing | Current prompt, bounded active user/assistant conversation text, the `explore` descriptor, and direct-child status may be sent to the host-selected classifier provider; one broad-discovery probability can add a system-prompt routing section. Failure adds no section and does not block the request. Local debug logs retain the decision and classifier metadata, not the prompt or conversation text |
| Project instructions | `AGENTS.md` and `CLAUDE.md` are path-labelled user-role request context outside the system prompt; they do not replace system, developer, user, or authorization rules |

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
`web_search` returns discovery metadata only. Selected URLs must be passed to
`fetch_content`, which returns matching passages rather than full pages.
Remote PDFs use the same SSRF checks; they are converted through the
reload-scoped `felan:markitdown:pdf-convert:v1` event with awaited semantics
and no fallback parser. MarkItDown is otherwise used for supported local
documents, including PDFs and Office documents.

Web Access does not retain remote bodies, page stored results, register session
hooks, create GitHub checkouts, or generate nested answers.

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

Attaching to an existing browser is a high-trust action. The separate
`browser_authorize` tool uses local host authorization (consent is interactive
by default), reads only a bounded stable-Chrome `DevToolsActivePort` file, and
creates a current-session pinned attachment. After authorization, the ordinary
browser tool exposes the native command surface, including authenticated data
and advanced browser commands. Felan replaces routing and output options and
does not expose the leased endpoint. Revoke and shutdown disconnect the Felan
session without closing externally owned Chrome. CDP remains browser-level
authority; the attachment is not a security sandbox. The local TUI defaults to
asking before each new authorization, with an optional persisted
`extensionConfig.browser.authorizationPolicy: "always-allow"` setting that can
be reset to `ask`. A managed CLI install does not install Chrome.

## Dependency installation

Binary-backed extensions degrade safely when dependencies are absent. The local
TUI offers one initially unchecked installation checklist; checking an item is
the explicit authorization for that reviewed installation, while unchecked items
use their safe fallback. It never installs during non-interactive runs or model
tool calls. Managed installers use reviewed versions, verify download/binary
integrity, avoid package lifecycle scripts, and stage candidates in agent storage.

POSIX utilities required for detached background processes are probed but not
installed by Felan Code. Binary-backed extensions may use the optional runtime
process capabilities; these preserve literal argv and separate protocol output
from diagnostics. See [Runtime dependencies](../reference/runtime-dependencies.md).

## Safe operating checklist

Before using Felan Code with a sensitive or untrusted project:

1. run it in an isolated host if shell execution is not trusted;
2. review the cwd-level `AGENTS.md`/`CLAUDE.md` and explicit skills;
3. keep `$FELAN_AGENT_DIR` outside the repository and protect its permissions;
4. authorize browser attachments and MCP servers deliberately;
5. restrict `ssrf.allowRanges` to owned services, if it is needed at all; and
6. treat web, document, MCP, browser, and memory content as untrusted data.
