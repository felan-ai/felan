# Local coding agents: feature comparison

> Last updated: 2026-08-21. Felan rows reflect local version `0.12.10` at the
> current repository commit; competitor source snapshots remain dated in the
> [comparison methodology](methodology.md).

This document compares behavior reachable from the **local terminal agents**
provided by Felan, OpenAI Codex, OpenCode, Claude Code, Pi, and Oh My Pi (OMP).
It excludes separate web, desktop, and IDE product surfaces, team
administration, pricing, and model quality.

The goal is a feature inventory, not a recommendation. A feature being present
does not establish how reliably a model uses it.

Coverage is limited to user-visible workflow state, tools, local integrations,
configuration, safety boundaries, and invocation modes documented by the
reviewed snapshots. It is not an inventory of internal APIs or every shortcut.
A [comparison index](README.md) turns the matrix into decision-oriented pages.
A remote service is included only when the local terminal exposes it as a tool;
that cell says when the operation is remote-backed. Version-, model-, flag-, or
dependency-specific availability is stated in the cell.

## How to read the matrices

- **Ships** means the implementation is included in the reviewed local agent.
  Felan's source-controlled extensions count as shipping features because the
  `felan` application includes and enables them by default.
- **Conditional** means the implementation ships but depends on a model,
  provider, feature flag, configuration choice, or external executable.
- **Integration** means a separately installed plugin, extension, browser
  component, language server, or other local component supplies the feature.
- **No core feature** does not mean the workflow is impossible. A prompt, shell
  command, or extension may approximate it; the entry describes first-class
  state and tools only.

Cells prioritize exact semantics over repeating one of these labels. Labels are
shown where availability would otherwise be ambiguous. Rows compare the nearest
first-class subsystem, not necessarily equivalent internal implementations.

## Feature matrix

### Planning, tasks, and agent coordination

Sources: Felan [tasks][felan-tasks], [subagents][felan-subagents], and
[Prewalk][felan-prewalk]; Codex [Plan][codex-plan] and
[subagents][codex-subagents]; OpenCode [todo][opencode-todo],
[agents][opencode-agent-source], and [task][opencode-task]; Claude Code
[tasks][claude-tools], [subagents][claude-subagents], and
[teams][claude-teams]; OMP [todo][omp-todo], [task][omp-task], and
[Agent Hub][omp-agent-hub].

| Feature | Felan | Codex | OpenCode | Claude Code | Pi | Oh My Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Progress/task state | **Ships:** persistent root-session task objects with stable IDs, title, description, acceptance criteria, priority, lifecycle, notes, and required completion result | **Ships:** `update_plan` checklist of short steps with `pending`, `in_progress`, and `completed` status | **Ships:** per-session `todowrite` list with content, priority, and four statuses; the whole list is replaced on update | **Conditional:** ships, but model-gated; `TaskCreate/Get/List/Update` objects have IDs, details, dependencies, owner, and metadata; legacy `TodoWrite` is disabled by default | **No core feature** | **Ships:** phase-oriented `todo` list with pending, active, completed, abandoned, and blocked states; separate from subagent execution |
| Hard dependency graph | **Ships:** `blocked_by` edges, cycle rejection, ready/blocked frontier views, and only completed prerequisites satisfy an edge | No | No | Dependency fields (`blocks` and `blockedBy`) exist; the public docs do not describe Felan's cycle and frontier invariants | No | Todo items can be blocked with a reason, but the todo list is not a dependency graph |
| Worker ownership and claims | **Ships:** a ready task is atomically claimed by a session; one active task per worker; stale claims require explicit forced recovery | No task ownership | No owner; one list item is active at a time | Optional owner and agent-team claim workflow when Task tools are available | No | Todo items have no owner; spawned agents instead have registry identities and assignments |
| State shared with child agents | **Ships:** one graph for the root and every nested child | Parent checklist is not documented as shared subagent execution state | Built-in subagents are denied `todowrite` by default and use child sessions | Agent teams can share the task list; ordinary subagents primarily report results to their caller | No core task state | Parent/child agents share session artifacts, registry, messaging, and job state; todo and task fan-out remain separate mechanisms |
| Task presentation | `/tasks` list, detail, ready-state, and dependency-graph views | Plan/checklist rendering in the conversation | Todo rendering in the TUI | Toggleable task checklist plus task tools | No core task state | Phase/task tree plus Agent Hub and job views |
| Conventional plan mode | **No** | **Ships:** non-mutating conversational Plan mode with a final proposed plan | **Ships:** Plan agent writes a plan artifact; `plan_exit` asks before switching to Build | **Ships:** Plan permission mode and `ExitPlanMode` approval | **No core feature** | **Ships:** protected plan artifact and explicit execution choices |
| Automatic planner-to-implementer routing | **Prewalk:** model- or user-entered, same session and useful full history; when task tools are active, requires task creation/claiming before switching after the first recognized edit | No equivalent first-mutation handoff | No equivalent first-mutation handoff | No equivalent first-mutation handoff | No core feature | Has its own Prewalk model handoff in addition to plan mode |
| Built-in subagents | **Ships:** custom and bundled types | **Ships:** default, worker, explorer, and custom TOML agents | **Ships:** general, explore, scout, and custom agents | **Ships:** built-in and custom agents | **No core feature** | **Ships:** configurable task agents plus specialized roles |
| Parallel/asynchronous children | Every launch is asynchronous; default concurrency four | Parallel threads; caller can wait, steer, stop, resume, and close | Foreground by default; background subagents are experimental and environment-gated | Foreground or background subagents | **Integration:** required | Background execution is normally enabled; batch fan-out and mixed blocking/non-blocking agents are supported |
| Nested agents | Bounded nesting; default depth three | The reviewed docs do not promise nested spawning | Configurable depth; default depth one | Subagents can be resumed; teams coordinate peers | **Integration:** implementation-defined | Nested agents and parent/child lineage are first-class |
| Child inspection/control | Live navigator, transcript, steering, continuation under the same child ID, cancellation, completion notices | Inspectable agent threads; steer, interrupt, wait, resume, and close | Navigate parent/child sessions; resume a child through its task ID | Inspect and resume agents; named background agents; experimental team display and messaging | **Integration:** implementation-defined | Agent Hub shows live and persisted children with transcripts, steering, revive, kill, lineage, usage, and artifacts |
| Typed child results | Text result and normalized status record; no caller-supplied output schema | Text summaries | Text result | Text result | **Integration:** implementation-defined | Per-agent or per-call JSON Schema, permissive/strict validation, typed extraction, and `agent://` artifacts |
| Isolated child workspaces | No | Per-agent sandbox policy, but no documented automatic worktree per child | No built-in child worktree isolation | Custom subagents can use `isolation: worktree`; `/batch` plans and launches independent units in worktrees | **Integration:** implementation-defined | Optional worktree/filesystem isolation with patch capture and merge support |
| Peer-to-peer agent messaging | Parent can steer direct children; no sibling messaging protocol | Parent-mediated control | Parent/child session navigation; no built-in sibling bus | Experimental agent teams and newer cross-session messaging | **Integration:** implementation-defined | IRC-style peer coordination plus agent-facing `hub` messaging |
| Second-model reviewer/advisor | Reviewer is an invokable agent type, not a turn observer | Custom agent or hook | Custom agent or plugin | Built-in `/advisor` consults a second model at selected moments; hooks and custom agents provide other patterns | **Integration:** implementation-defined | Built-in advisor role can watch every turn and inject feedback |
| Structured user questions | `ask_user`: one question or 1–4 step wizard, search, multi-select, freeform, comments, layouts, and timeout | `request_user_input` for structured decisions | `question` supports multiple prompts, choices, multi-select, and custom answers | `AskUserQuestion` multiple-choice workflow | **Integration:** required | `ask` option picker |
| Scheduled/recurring session work | No scheduler | No core session scheduler documented | No core session scheduler documented | `CronCreate/Delete/List`, fixed or self-paced `/loop`, restored unexpired session schedules | **Integration:** required | No core scheduler documented |

### Context, memory, and sessions

Sources: Felan [progressive context][felan-context] and [local TUI][felan-tui];
Codex [AGENTS.md][codex-agents] and [feature defaults][codex-features]; OpenCode
[instruction loader][opencode-context] and [TUI commands][opencode-tui]; Claude
Code [memory/instructions][claude-memory] and
[checkpointing][claude-checkpoints]; Pi [usage][pi-overview]; OMP
[context discovery][omp-context] and [feature inventory][omp-overview].

| Feature | Felan | Codex | OpenCode | Claude Code | Pi | Oh My Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Startup project instructions | At most one file in the session cwd: `AGENTS.md`, then `CLAUDE.md` | Global instructions plus one `AGENTS.override.md`, `AGENTS.md`, or fallback file per directory from repo root to cwd | Global file plus ancestor project files; `AGENTS.md` wins as a filename family over `CLAUDE.md` | Managed, user, project, and local `CLAUDE.md` files; does not read `AGENTS.md` unless imported | Global and ancestor-to-cwd `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` | Discovers native and foreign instruction formats from OMP, Claude, Codex, Gemini, OpenCode, Copilot, and other locations |
| Progressive nested instructions below cwd | **Ships:** after a structured `read` or decoded `@file`, loads one `AGENTS.md`/`CLAUDE.md` per traversed nested directory for subsequent turns | **No core feature:** instruction chain stops at launch cwd and is rebuilt on a new run | **Ships:** a successful `read` attaches nested `AGENTS.md`, `CLAUDE.md`, or legacy `CONTEXT.md` files on the path to the file | **Ships:** nested `CLAUDE.md` and `CLAUDE.local.md` files load when Claude reads in those directories | No core progressive loader | Reviewed context files are discovered before session start; no on-read loader is documented |
| Behavior after compaction | Progressive instructions are re-injected as hidden context after compaction | Startup instructions remain part of reconstructed context | Read metadata prevents duplicate injection; compacted read entries can be rediscovered | Memory files and applicable rules remain session context | Context files and compaction are core, but no nested progressive state exists | Sticky rules and stream-rule injections are designed to survive compaction |
| Path-scoped rule system | Nested instruction files only; no independent glob-scoped rules | Directory-scoped `AGENTS.md`; hooks can add dynamic policy | Explicit instruction globs/URLs; nested instruction files | `.claude/rules/*.md` can use path scopes; `CLAUDE.md` supports recursive imports | **Integration:** implementation-defined | Imported rule formats, sticky `RULES.md`, rulebook entries, and time-traveling stream rules |
| Automatic durable memory | No built-in auto-memory | **Conditional:** reviewed source marks `memories` stable but disabled by default | No built-in auto-memory | **Ships:** project-scoped auto memory plus per-subagent memory options | No core memory | **Conditional:** configurable local/Hindsight/Mnemopi memory tools ship but are setting-gated |
| Agent Skills | Explicit global/workspace `.agents/skills` supplied to root and children | Built-in skill discovery and configuration | On-demand skill tool; OpenCode, Claude, and `.agents` locations; permission patterns | Built-in skills with user/project/plugin scopes | Built-in on-demand Agent Skills | Built-in managed/imported skills plus `learn` and `manage_skill` |
| Custom prompts/commands | One Felan application prompt append; no ambient Pi prompt templates | Skills, plugins, agent files, and hooks | Markdown custom commands, agents, instructions, and plugins | Skills, plugins, hooks, custom agents, and commands | Prompt templates, system prompt replacement/append, extensions | Prompt templates, magic keywords, modes, extensions, and imported command formats |
| Local session persistence | Ships | Ships | Ships | Ships | Ships | Ships |
| Resume and session picker | Continue most recent; Pi session commands remain available in TUI | Resume by ID/name/recent; archive/unarchive/delete | `/sessions`, `/resume`, `/continue` | Continue/resume and session picker | Picker and direct ID/path selection | Picker plus persisted subagent artifacts |
| Conversation branching | Pi tree, fork, and clone behavior is inherited | `codex fork` creates a new local chat | No general conversation tree; parent/child agent sessions are navigable | Session fork plus worktree workflows | In-place session tree, fork, and clone | Pi-derived session tree/fork/clone plus additional operations |
| File checkpoint/rewind | **No:** conversation branching does not restore the working tree | No first-class file rewind documented | `/undo` and `/redo` revert/restore the last message and Git-backed file changes | Automatic checkpoints and rewind choices for conversation and code | No core file checkpoint | **Conditional:** `checkpoint` and `rewind` tools ship but are setting-gated |
| Automatic/manual context compaction | Pi automatic compaction plus `/compact` | Automatic compaction plus controls/hooks | Automatic compaction agent plus `/compact` | Automatic compaction plus `/compact` and hooks | Automatic and manual compaction; extension-overridable | Compaction plus checkpoint/rewind and native summarization controls |
| Prompt steering/queue | Pi steering and follow-up queues | Follow-up input can be queued while work runs | Session prompt queueing | Messages can be queued and taken back while Claude works | Separate steering and follow-up queues | Pi-derived queueing plus live subagent steering |
| Local non-interactive/API mode | **Ships:** `felan --mode text` prints one final response; `--mode json` emits Pi-compatible JSONL; `--continue` and exact model selection are supported | `codex exec` with text or JSONL events; local app-server protocol | `opencode run`, local server, SDK/OpenAPI, and ACP | `claude -p` output formats and Agent SDK | Print, JSON, RPC, and Node SDK | Print, RPC/RPC-UI, Node SDK, and ACP |

### Local tools, execution, and code intelligence

Sources: Felan [Codex tools][felan-codex], [background Bash][felan-background],
and [RTK optimizer][felan-rtk]; Codex [shell schema][codex-shell]; OpenCode
[shell][opencode-shell], [truncation][opencode-truncation], and
[LSP][opencode-lsp]; Claude Code [tools][claude-tools] and
[interactive mode][claude-interactive]; Pi [usage][pi-overview]; OMP
[tool inventory][omp-overview].

| Feature | Felan | Codex | OpenCode | Claude Code | Pi | Oh My Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Core filesystem/search tools | Ordinary models get `read`, `write`, `edit`, and `bash`; search is normally performed through shell commands | Structured shell plus `apply_patch`; repository search/read normally use shell commands | `read`, `glob`, `grep`, and shell, plus either `edit`/`write` or `apply_patch` depending on model | `Read`, `Write`, `Edit`, `Glob`, and `Grep` | `read`, `write`, `edit`, and `bash` | Unified `read`/`write`, hashline `edit`, `grep`, `glob`, AST search/edit, archives, databases, and internal URL schemes |
| Model-adapted editing/tool surface | GPT models on OpenAI providers switch to Codex-style `exec_command`, `write_stdin`, `apply_patch`, and optional `view_image`; other models keep Pi tools | Native structured Codex tool surface | GPT-family models other than GPT-4/OSS receive `apply_patch` instead of `edit`/`write`; agents can further restrict tools | Same Claude tool contracts; plugins can add deferred tools | Extensions can replace any tool | Model-specific prompts and hashline editing; broad fixed built-in surface |
| Foreground shell | Ships | Ships | Ships; shell commands are parsed for permission patterns | Ships; Bash and native PowerShell where supported | Ships | Persistent embedded shell with in-process utilities |
| First-class background shell jobs | **Conditional:** detached jobs with list/read/wait/stop, persisted logs, TUI overlay, and completion notices for non-OpenAI-family models on runtimes with the required POSIX job facilities | Long processes yield a session ID and remain interactive during the session; no detached job registry comparable to Felan's | No first-class background shell tool in the reviewed snapshot | **Ships:** background Bash tasks, task IDs/output files, `/tasks`, and the `Monitor` tool for reactive streams/WebSockets | No core feature | **Ships:** persistent shell sessions, PTY, background dispatch, job manager, and `/jobs`/Hub control |
| PTY and stdin | GPT/OpenAI tool mode can allocate a real PTY and use `write_stdin`; ordinary Bash is non-interactive | `exec_command` supports PTY, yield timeout, polling, and stdin | Shell stdin is ignored; no general PTY interaction tool | Background and foreground Bash are first-class; no general model-facing PTY contract is documented | Core Bash is non-interactive | Native PTY supports interactive prompts, SSH, and sudo |
| Generic output bounds | Final Felan cap defaults to 12,000 characters with a recoverable head-and-tail preview; explicit short/ranged reads remain exact | Per-call output token budget defaults to 10,000 tokens | Generic 2,000-line/50 KiB cap by default; full output is saved for targeted read/search | Bash streams to a file, returns roughly 30,000 characters inline by default, and exposes the saved path for larger output | Built-in tool truncation plus context compaction | Tool-specific limits, summarized reads, saved artifacts, and internal URL retrieval |
| Command-aware token optimization | **Conditional:** compaction ships; RTK rewrites supported commands only when `rtk` is installed; compacts build, test, Git, lint, search, Bash, read, and Codex output; Felan reports isolated RTK command-output and post-tool savings through `/gain` | No equivalent command rewriter; output has a token budget and context compaction | Generic truncation only; not command-aware semantic compaction | Generic output/file limits, subagents, ToolSearch, and compaction; no RTK-style command rewrite documented | **Integration:** required | Built-in shell minimizer, summarized reads/search, hashline edits, prompt tuning, and tool-specific compaction |
| LSP code intelligence | No | No built-in LSP tool | **Conditional:** many server definitions ship but LSP is disabled by default; diagnostics plus navigation/symbol/call-hierarchy tool | **Integration:** LSP tool activates after installing a code-intelligence plugin and server | **Integration:** required | **Ships:** diagnostics, navigation, symbols, rename, code actions, and raw requests |
| Automatic formatting after edits | No | No built-in formatter manager | **Conditional:** language-specific formatter manager ships disabled by default | Hooks or plugins | **Integration:** required | LSP/code-action and tool workflows; no separate generic formatter manager is claimed here |
| Debugger/DAP | No | No | No | No built-in debugger tool | **Integration:** required | **Ships:** DAP breakpoints, stepping, stack, variables, threads, and evaluation |
| Browser automation | **Conditional:** reviewed `agent-browser` 0.31.1 CLI integration with explicit session, attachment, and screenshot policy | No core browser tool in the reviewed CLI | Plugin/custom tool required | **Integration:** separate Claude-in-Chrome component | **Integration:** required | **Ships:** headless/attached Chrome and Electron/CDP; existing-tab control uses a browser relay integration |
| Desktop automation | No | No | Plugin/custom tool required | No general desktop-control tool | **Integration:** required | **Ships:** windows, displays, screenshots, native input, accessibility tree, and clipboard |
| Persistent Python/JavaScript evaluation | No | **Conditional:** experimental Code Mode exists in source but is disabled by default | No built-in persistent kernel | No persistent general-purpose eval kernel; does have `NotebookEdit` | **Integration:** required | **Ships:** persistent Python and Bun/JavaScript kernels that can call agent tools |
| Notebook editing | No specialized tool | No specialized tool | Read can attach PDFs/images; no notebook cell editor documented | `NotebookEdit` | **Integration:** required | Unified read plus notebook-aware operations |
| Image input/inspection | Pi image attachment support; GPT tool mode adds bounded `view_image` | Image attachments and paste | Image attachments and image-returning web fetch | Image paste/read and screenshots from integrations | Image paste and drag/drop | Image inspection, browser/desktop screenshots, terminal rendering; generation is setting-gated |
| PDF handling | Web fetch extracts bounded PDF text | No dedicated local PDF reader documented | `read` recognizes PDF attachments; web fetch itself is not a PDF extractor | `Read` supports PDFs within documented limits | No core PDF reader | Unified `read` handles local and remote PDFs |
| Specialized Git/review tools | Uses ordinary Git/`gh` through shell and reviewer subagents | Dedicated local `codex review` plus patch application | Git-backed undo/redo; ordinary Git through shell | Worktrees, checkpoints, `/code-review`, `/security-review`, and structured findings | Ordinary Git through shell/extensions | Review fan-out, PR/issue URL schemes, atomic commit planning, conflict URLs, and patch merging; the dedicated GitHub tool is setting-gated |

### Web research

Sources: Felan [web access][felan-web]; Codex [web search][codex-web] and
[security/network policy][codex-security]; OpenCode [web tool source][opencode-web];
Claude Code [tools][claude-tools] and [permissions][claude-permissions]; Pi
[usage][pi-overview]; OMP [web/tool inventory][omp-overview].

| Feature | Felan | Codex | OpenCode | Claude Code | Pi | Oh My Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Search backends | SearXNG, OpenAI, Exa, and Brave | Remote-backed OpenAI web search | Remote-backed Exa or Parallel | Remote-backed Anthropic web search | No core web search | 23 remote backends including APIs, self-hosted SearXNG, and keyless sources |
| Provider selection/fan-out | `auto`, strict named provider, selected provider array, or `all`; selected providers run concurrently | Cached by default; indexed, live, or disabled modes | One provider is selected per session or by environment override | Remote backend can refine one call into multiple searches | No core web search | `auto` walks a ranked fallback chain or one provider can be pinned |
| Multi-query search | Up to four queries per call; up to 20 results per query | Provider-managed | One query per tool call | Tool may issue up to eight backend searches while refining | No core web search | One query per tool call |
| Fetch/reader | Up to five URLs; readable Markdown, exact/raw text, page-grounded answer, or direct image | Search tool can expose results; no separate general local URL reader is documented | One HTTP(S) URL as Markdown, text, HTML, or image; 5 MiB limit | `WebFetch` takes a URL and extraction prompt, converts HTML, then normally returns a small model's answer rather than raw page content | No core fetcher | URLs use the same multi-format `read` surface as files |
| PDFs and repositories | PDF text with size/page limits; exact local GitHub checkout with bounded API fallback; images | Search result pages, not a dedicated Git/PDF fetch pipeline | No web PDF/Git clone pipeline; scout agent can research dependency source | WebFetch is page-oriented; local `Read` handles PDFs | **Integration:** required | PDF, GitHub/GitLab, registries, arXiv, Stack Overflow, docs, archives, and internal schemes |
| Claim verification | Dedicated `source_check` creates a bounded artifact with exact extracted passages | Search citations; no dedicated claim-check artifact | No dedicated claim-check tool | Search citations and prompted WebFetch extraction; no exact-passage claim-check artifact | **Integration:** required | Search answer/citations and structured readers; no separate claim-check tool documented |
| Full-result retrieval | One-hour externalized cache; response IDs, paging, offsets, exact/case-insensitive/fuzzy matching; 32 MiB per result and 64 MiB total | Provider-managed transcript results | Generic truncation saves local output; no search-result paging API | Large tool outputs can be saved to files; WebFetch is intentionally lossy | **Integration:** required | Internal URL schemes and file-like reads retain structured source access |
| Remote-content boundary | Every result, schema, image, and derived summary is explicitly marked as untrusted before model delivery | Official docs instruct treating web results as untrusted; cached mode reduces exposure | Permission-gated tools, but no equivalent explicit untrusted-content envelope is documented | Permission prompts and domain rules; fetched content is external model input | **Integration:** implementation-defined | Broad remote readers; reviewed docs do not describe Felan's explicit envelope contract |
| SSRF/private-network controls | Private, loopback, link-local, reserved, and internal destinations blocked by default; DNS pinned and redirects revalidated | Remote search is outside local command networking; optional command-network proxy blocks private destinations | `webfetch` validates HTTP(S), timeout, and size; no private-network/DNS-rebinding control is documented | Sandbox network allow/deny rules apply separately; WebFetch has domain permissions | **Integration:** implementation-defined | Broad URL/browser surface; no equivalent default private-network policy is claimed here |
| JavaScript/cookie-authenticated pages | Web access is HTTP/content extraction; the separate browser CLI does not import ambient browser cookies | No core browser in CLI | Plugin/custom tool | **Integration:** Claude-in-Chrome is separate from WebFetch | **Integration:** required | Browser automation ships; existing-tab control uses a browser relay integration |

### Extensibility, MCP, safety, and models

Sources: Felan [MCP][felan-mcp] and [local policy][felan-tui]; Codex
[hooks][codex-hooks], [MCP][codex-mcp], and [security][codex-security]; OpenCode
[plugins][opencode-plugins], [MCP][opencode-mcp], and
[permissions][opencode-permissions]; Claude Code [hooks][claude-hooks],
[MCP][claude-mcp], and [permission modes][claude-permissions]; Pi
[extensions][pi-extensions]; OMP [MCP][omp-mcp] and
[feature inventory][omp-overview].

| Feature | Felan | Codex | OpenCode | Claude Code | Pi | Oh My Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Executable extension policy | Only Felan's source-controlled built-ins; no ambient Pi extensions/packages | Plugins plus trusted local hooks | JS/TS plugins, hooks, and custom tools | Plugins, hooks, skills, agents, and MCP | Deep TypeScript extension API and installable Pi packages | TypeScript extensions/marketplaces plus a large built-in surface |
| Lifecycle hooks | No user-configurable general hook system | Stable command hooks across tool, session, compaction, prompt, and subagent events; hash-based trust | Plugin hooks across chat, tool, permission, session, file, and other events | Extensive command, HTTP, prompt, and agent hook events | Extension API exposes lifecycle events | Extension events, rules, advisors, and imported hook formats |
| Custom tools/UI | Skills and agent definitions only; application does not load user executable tools or themes | Plugins, MCP, hooks, and agents; CLI UI itself is not generally replaceable | Plugins can add tools and hooks; custom commands/agents; configurable TUI | Plugins/skills/agents/MCP/hooks; status line and integrations | Extensions can replace tools, editor, footer, widgets, dialogs, and themes with hot reload | Same Pi-style extension primitives plus built-in UI/tool APIs |
| MCP transports | Remote Streamable HTTP with SSE fallback only | Local stdio and remote Streamable HTTP | Local process and remote HTTP | Local stdio, HTTP, SSE, and SDK/in-process servers | No core MCP client | stdio, HTTP, and SSE |
| MCP authentication/config | OAuth only; explicit Felan files; OS credential store; no bearer/custom headers | OAuth, bearer tokens, environment, and configured headers/options | OAuth or headers/bearer; local environment and cwd | OAuth, headers/environment, managed configuration | **Integration:** required | OAuth, headers, environment/command credentials, profiles, and imported configs from many agents |
| MCP exposure to model | One lazy gateway for status/search/describe/call; remote tools are not injected directly | Deferred tool search and namespaces can reduce initial tool context | MCP tools are directly available and can consume substantial context | ToolSearch can defer MCP tool schemas; resources and prompts supported | **Integration:** implementation-defined | Broad discovery/import and model-facing tools/resources |
| MCP features Felan rejects | Stdio, sockets, bearer tokens, arbitrary headers, direct tools, resources/prompts, Apps, sampling, scripting | Supports substantially more of this surface | Supports local and remote tools with flexible auth | Supports tools, resources, prompts, Apps/connectors depending configuration | **Integration:** implementation-defined | Supports local/remote transports and imported server definitions |
| OS-enforced local sandbox | **No** | **Yes:** platform sandbox with writable-root and network controls | No documented whole-agent OS sandbox | **Optional:** sandbox for Bash and subprocesses on supported platforms | No; optional container/extension approaches | No Codex-style default whole-agent sandbox documented |
| General action permissions | **No general approval layer** | Approval policy plus sandbox; read-only and workspace-write modes | Granular allow/ask/deny by operation and pattern; reviewed defaults are permissive except selected risks | Manual/auto/accept-edits/plan/bypass modes plus allow/ask/deny rules | Project trust protects loading project executable resources, not model actions | Tool prompts/proposals and ACP permission requests exist, but not a uniform default gate equivalent to Codex/Claude |
| Command network policy | Unrestricted host network for shell commands; web-access tool has its own SSRF boundary | Network off by default in workspace sandbox; opt-in allowlist proxy and private-address controls | Permission rules can gate commands; no OS-level egress policy | Sandbox network rules and WebFetch domain permissions | Host network unless externally isolated | Broad local/browser/network tools; user configuration controls them |
| Project executable-code trust | No project trust prompt because ambient executable extensions/settings are filtered | Project config/hooks require trust/review | Project plugins/config can execute under normal OpenCode policy | Project hooks/plugins/settings have trust and permission rules | Explicit project trust before loading project extensions/packages/settings | Broad imported discovery means repository configuration must be reviewed |
| Provider/model breadth | Pi provider catalog; exact authenticated model selection and deterministic high/medium/low tiers | OpenAI models by default; custom OpenAI-compatible provider endpoints | 75+ providers and local models | Claude models through configured Anthropic, Bedrock, Google, and Microsoft routes | Broad provider catalog, subscriptions, custom providers, and local llama.cpp | 60+ providers, local servers, custom APIs, credential rotation, and fallback chains |
| Cross-model role routing | Subagent tiers and exact models; Prewalk target; provider-family preference | Per-agent model and reasoning configuration | Per-agent model; primary/subagent inheritance | Per-subagent model; agent teams use configured agents | User/extension controlled | Ten model roles, path-scoped models, task/advisor/plan routing, and fallbacks |
| Local models | Through Pi's supported custom/local provider layer, but Felan does not expose Pi project model configuration | OSS mode/custom endpoints are supported by CLI configuration | Ollama, llama.cpp, LM Studio, and other local/OpenAI-compatible providers | No general local-model support | Built-in llama.cpp router and custom providers | Ollama, LM Studio, llama.cpp, vLLM, LiteLLM, and custom endpoints |
| Local TUI observability | Grouped tool activity; full call inspector; task graph; child rail/navigator; background-job overlay; Git/model/token/cost/context/subscription powerline | Tool/diff display, plan/status, agent threads, permission/sandbox status | Tool details, todo, child-session navigation, undo/redo, themes, mouse, notifications | Transcript viewer, task/background views, permissions, rewind, agents, status line | Session tree, tool/thinking collapse, footer usage/cost/context, extension UI | Agent Hub, jobs, todo phases, advisor, usage/cost, patches, collaboration, rendered tool cards |

## Important differences in feature depth

### Felan tasks are an execution graph, not a todo list

The task row needs more than a checkmark:

| System | Actual state model |
| --- | --- |
| **Felan** | Stable task objects with priority, acceptance criteria, hard prerequisite edges, cycle validation, ready/blocked queries, per-worker ownership, atomic claims, forced stale-claim recovery, handoff notes, and verified results. One graph is shared by the root and every nested child. |
| **Codex** | `update_plan` is an ordered progress checklist. Its own Plan-mode prompt explicitly says this is separate from Plan mode. It has no dependency or ownership model. |
| **OpenCode** | `todowrite` replaces a session list of `{content, status, priority}` items. It enforces one active item through prompting, but has no edges, claims, results, or cross-agent graph. Built-in subagents are denied the todo tool unless configured otherwise. |
| **Claude Code** | Current Claude Code is no longer accurately described as only a simple `TodoWrite` list. Its Task tools support IDs, details, dependencies, owners, and metadata. However, availability is model/version dependent, and the public contract does not include Felan's priorities, acceptance criteria, atomic one-task-per-worker claims, explicit ready frontier, forced stale recovery, or required verified result. |
| **Pi** | No task state in core. An extension can define any model. |
| **OMP** | `todo` is a phased checklist with blocker states and transactional operations. The separate `task` tool runs subagents with batching, concurrency, typed output, artifacts, isolation, and registry state. It does not combine those two mechanisms into Felan's shared prerequisite graph. |

Felan's graph is **Beads-like in its dependency-oriented execution shape**, but
it is not Beads or a project issue tracker. It is scoped to one root session and
has no durable project backlog, remote synchronization, labels, estimates,
comments, or due dates.

### Prewalk still is not plan mode

Prewalk is automatic model routing within one session—not a plan-review gate,
separate planning agent, or read-only mode. Model-requested entry asks for user
approval by default, but that approval starts Prewalk rather than approving a
non-mutating plan artifact or later edits.

The model can call `enter_prewalk` before complex repository work, or the user
can invoke `/prewalk`. Small localized edits and routine one-file fixes should
normally stay on the regular path. Once active, the current model explores,
creates and claims a prompted task graph of at most nine tasks, begins
implementation, and performs a focused mutation. When both task tools are
active, successful `TaskCreate` and `TaskUpdate` calls claiming `in_progress`
work are required before that mutation marks the turn for handoff. If the task
tools are unavailable, a successful explicit mutation marks it directly. The
next request goes to the configured tier or exact model at the configured
implementation thinking level (exact `medium` by default) with
the useful transcript and tool history; successful entry controls and stale
phase guidance are filtered from model context, while the current transient
guidance stays at a stable position within its phase. The target finishes and
verifies the work, after which Felan normally restores the planner
model and thinking level. `/prewalk exit` cancels a pending handoff or defers
restoration until active target inference settles.

Important limits:

- there is no read-only planning phase or plan artifact;
- there is no approval checkpoint before edits;
- when both task tools are active, successful task creation and claiming gate the handoff;
- shell mutations do not trigger handoff; and
- more than one explicit mutation can occur in the qualifying turn.

Codex, OpenCode, Claude Code, and OMP all provide a non-mutating or
edit-restricted planning workflow with a plan proposal or transition. The
enforcement differs: Codex uses explicit Plan-mode instructions, OpenCode denies
edit tools outside its plan paths while shell behavior still follows the active
permission policy, and Claude Code/OMP expose their own plan guards and approval
flows. Pi leaves both workflows to extensions. OMP also implements a separate
Prewalk workflow.

### Felan web access is an evidence pipeline, not only search

Felan's four web tools form one bounded retrieval workflow:

1. `web_search` can run up to four queries and search one, several, or all
   configured providers.
2. `source_check` searches for evidence about a claim and can retain exact
   passages from up to five fetched pages.
3. `fetch_content` handles readable or raw pages, grounded answers, PDF text,
   images, and GitHub repository content.
4. `get_search_content` pages through externally cached results or finds exact,
   case-insensitive, or fuzzy matches without placing every fetched byte in the
   active transcript.

The retrieval layer validates DNS, pins connections, rechecks redirects, blocks
private/reserved destinations by default, bounds model-visible output, and marks
remote content as untrusted at each model boundary.

That adds evidence and retrieval operations beyond the search/fetch pair in
OpenCode and the remote search plus lossy prompted fetch in Claude Code. Codex
has a lower-exposure cached-search default and OS-enforced command-network
isolation, but not the same local evidence artifact/paging interface. OMP
prevents a simple claim that Felan has “more web”: OMP has far more providers,
specialized handlers, browser automation, and one file-like reader for URLs and
PDFs. Felan's additional depth is specifically in **claim checking, bounded
retained content, explicit trust marking, and SSRF controls**.

### Progressive context is shared by Felan, OpenCode, and Claude Code

Felan is not unique in progressively loading nested instruction files:

- **Felan** starts with one cwd-level `AGENTS.md` or `CLAUDE.md`, then discovers
  nested files after structured reads or decoded `@file` attachments. Discovered
  instructions are deduplicated and re-injected after compaction.
- **OpenCode** loads global/ancestor instructions and appends nearby nested
  `AGENTS.md`, `CLAUDE.md`, or legacy `CONTEXT.md` content to successful `read`
  results.
- **Claude Code** loads `CLAUDE.md` files above the cwd at launch and discovers
  files below it when working in those directories. It additionally supports
  imports, `.claude/rules` path scopes, and auto memory.
- **Codex**, **Pi**, and the reviewed **OMP** context loader discover applicable
  files at session start but do not document the same on-read nested behavior.

Felan's current trigger also has limits: shell reads do not count, image inputs
do not expose a path, and the new instruction affects the model call after the
qualifying read.

### RTK and background Bash are separate features

The RTK optimizer has two layers:

- output compaction ships in Felan and performs command-aware aggregation for
  tests, builds, Git, linters, and searches, strips ANSI, protects context with
  a final cap, and records estimated savings;
- command rewriting delegates to a managed or `PATH` `rtk` executable. If it is
  unavailable, the default guard leaves commands unchanged while compaction
  continues; the local TUI offers explicit installation or a persisted
  missing-dependency acknowledgement through dependency onboarding.

OpenCode and Claude Code preserve large raw output in files and return a bounded
preview; Codex exposes a model-settable output token budget. Those are useful,
but they are generic truncation rather than RTK's command-aware rewriting and
semantic aggregation. OMP has its own extensive read/search/shell minimization
and editing optimizations.

Felan's detached background Bash jobs are also different from merely adding
`&` to a shell command. They have IDs, statuses, logs, wait/stop tools, process
groups, completion messages, and a TUI overlay. This extension is active for
models outside the exact OpenAI provider family and requires POSIX facilities
such as `nohup`, `ps`, and `setsid` or shell job control; incompatible runtimes
leave the extension inactive. GPT/OpenAI sessions
instead get Codex-style in-memory process sessions with PTY/stdin and polling;
those are not restart-durable detached jobs.

## Features other local agents provide beyond Felan's reviewed surface

This list is intentionally explicit.

### Safety and approval

- **Codex:** OS-enforced command sandbox, writable-root restrictions,
  configurable approvals, network-off defaults, and an optional allowlist
  network proxy.
- **Claude Code:** general permission rules/modes and an optional Bash sandbox.
- **OpenCode:** per-tool and pattern-level allow/ask/deny rules, although its
  reviewed defaults are much more permissive than Codex's sandbox.
- **Felan:** no general action-approval system and no OS sandbox. Its web-fetch
  SSRF boundary does not restrict shell commands.

### Planning and recovery

- Read-only or edit-restricted plan review and approval in Codex, OpenCode,
  Claude Code, and OMP.
- Git-backed message/file undo and redo in OpenCode.
- Automatic code checkpoints and rewind in Claude Code.
- Checkpoint/rewind and context-pruning tools in OMP.
- Felan's Pi conversation tree can branch history, but it does not restore files.

### Code intelligence and additional local tools

- Structured `glob`/`grep` tools in OpenCode, Claude Code, and OMP. Felan usually
  performs these operations through shell commands.
- LSP navigation/diagnostics in OpenCode, plugin-backed Claude Code, and OMP.
- Formatter management in OpenCode.
- DAP debugging in OMP.
- AST search, staged structural edits, conflict-resolution URLs, native GitHub
  operations, and dedicated commit planning in OMP.
- Notebook cell editing in Claude Code and notebook-aware reads in OMP.
- Persistent Python/JavaScript kernels with tool re-entry in OMP.

### Browser, desktop, and media

- Browser automation through Claude-in-Chrome and OMP's browser/relay.
- General host desktop automation in OMP.
- Browser-backed fetching of JavaScript-heavy or cookie-authenticated pages;
  Felan's web fetcher is HTTP/content extraction, while its separate
  `agent-browser` integration does not import ambient browser cookies or provide
  OMP's existing-tab relay.
- Image generation, text-to-speech, model-based image inspection, and terminal
  image rendering in OMP.

### Agent coordination

- Schema-validated child results and isolated child worktrees in OMP.
- Worktree-isolated custom subagents in Claude Code.
- Peer messaging and shared-agent-team coordination in Claude Code and OMP.
- A second-model advisor in Claude Code and a continuous turn-watching advisor
  in OMP.
- Relay-backed read/write or read-only live-session collaboration in OMP.
- Felan can steer children and share dependency state, but it has no sibling bus,
  typed output schema, worktree isolation, or multi-user live session.

### Extensibility and integrations

- User-installed executable plugins, lifecycle hooks, custom tools, and UI
  extensions in Codex, OpenCode, Claude Code, Pi, and OMP.
- Local stdio MCP in Codex, OpenCode, Claude Code, and OMP.
- Bearer tokens/custom headers and broader MCP resources/prompts/tool surfaces in
  those clients.
- Felan intentionally exposes only remote OAuth MCP through one gateway and does
  not load arbitrary Pi extensions or packages.

### Memory, rules, and automation

- Claude Code auto memory, imports, and path-scoped `.claude/rules`.
- OMP's full memory bank, sticky/stream rules, and learned-skill promotion.
- Opt-in local memories in the reviewed Codex source.
- Scheduled session prompts and reactive `Monitor` streams in Claude Code.
- Felan has session task state and progressive instructions, but no durable
  learned-memory subsystem or scheduled prompt engine.

### Local invocation surfaces

- Non-interactive structured output from Codex, OpenCode, Claude Code, Pi, and
  OMP.
- RPC/SDK protocols in Pi and OMP, local server/SDK/OpenAPI in OpenCode, and
  agent SDKs in Claude Code.
- Felan's current published local binary is TUI-only; passing a message starts
  the TUI rather than producing a one-shot result.

## Sources and method

This is a source review of observable local-agent behavior, not a hands-on model
quality benchmark. Marketing claims were used only when the linked source or
official reference described the corresponding implementation.

- **Felan:** local version `0.12.10`, commit
[`abd4ee34ab2bc2289802af4d2a317b56239f44c5`][felan-snapshot]. Sources:
  [local TUI][felan-tui], [tasks][felan-tasks],
  [subagents][felan-subagents], [Prewalk][felan-prewalk],
  [progressive context][felan-context], [web access][felan-web],
  [background Bash][felan-background], [RTK optimizer][felan-rtk],
[MCP][felan-mcp], [Codex tools][felan-codex], [browser][felan-browser], and
[structured questions][felan-ask].
- **Codex:** local source checkout at
  [`aea26afaee177d3fe40721ef261a29f89879d505`][codex-snapshot]. Sources:
  [Plan prompt][codex-plan], [`update_plan` prompt][codex-update-plan],
  [subagents][codex-subagents], [AGENTS.md][codex-agents],
  [feature defaults][codex-features], [shell schema][codex-shell],
  [web search][codex-web],
  [security][codex-security], [hooks][codex-hooks], and [MCP][codex-mcp].
- **OpenCode:** local version `1.18.10`, commit
  [`14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5`][opencode-snapshot]. Sources:
  [todo][opencode-todo], [agents and Plan][opencode-agent-source],
  [subagent task][opencode-task], [progressive instructions][opencode-context],
  [web tools][opencode-web], [shell][opencode-shell],
  [output truncation][opencode-truncation], [LSP][opencode-lsp],
  [permissions][opencode-permissions], [plugins][opencode-plugins],
  [MCP][opencode-mcp], and [TUI/session commands][opencode-tui].
- **Claude Code:** current official local CLI documentation reviewed on the date
  above: [tools and task availability][claude-tools],
  [task migration][claude-tasks], [permissions/Plan mode][claude-permissions],
  [project memory and progressive `CLAUDE.md`][claude-memory],
  [subagents][claude-subagents], [agent teams][claude-teams],
  [commands and bundled workflows][claude-commands],
  [interactive/background tasks][claude-interactive],
  [checkpointing][claude-checkpoints], [hooks][claude-hooks],
  [MCP][claude-mcp], and [Chrome][claude-chrome].
- **Pi:** Felan pins `@earendil-works/pi-*` `0.84.3`. Sources:
  [Pi usage and core feature inventory][pi-overview],
  [extensions][pi-extensions], [providers][pi-providers], and
  [containerization][pi-containers].
- **Oh My Pi:** version `17.3.6`, commit
  [`54e1a8c900d30e5b6185975ab02a4a923faf1717`][omp-snapshot]. Sources:
  [feature/tool inventory][omp-overview], [todo][omp-todo],
  [task agents][omp-task], [context discovery][omp-context],
  [Plan prompt][omp-plan], [Prewalk][omp-prewalk],
  [Agent Hub][omp-agent-hub], and [MCP][omp-mcp].

Recheck the linked sources when defaults or security boundaries matter. In
particular, Claude Code gates its current task tools by model/version, OpenCode
ships some capabilities disabled or experimental, and Codex's reviewed source
contains feature flags that are not all enabled by default.

[felan-snapshot]: https://github.com/felan-ai/felan/tree/abd4ee34ab2bc2289802af4d2a317b56239f44c5
[felan-tui]: ../../apps/tui/README.md
[felan-tasks]: ../../packages/ext-tasks/README.md
[felan-subagents]: ../../packages/ext-subagents/README.md
[felan-prewalk]: ../../packages/ext-prewalk/README.md
[felan-context]: ../../packages/ext-context/README.md
[felan-web]: ../../packages/ext-web-access/README.md
[felan-background]: ../../packages/ext-background-bash/README.md
[felan-rtk]: ../../packages/ext-rtk-optimizer/README.md
[felan-mcp]: ../../packages/ext-mcp/README.md
[felan-codex]: ../../packages/ext-codex/README.md
[felan-browser]: ../../packages/ext-browser/README.md
[felan-ask]: ../../packages/ext-ask-user/README.md
[codex-snapshot]: https://github.com/openai/codex/tree/aea26afaee177d3fe40721ef261a29f89879d505
[codex-plan]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/collaboration-mode-templates/templates/plan.md
[codex-update-plan]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/core/gpt_5_1_prompt.md#update_plan
[codex-subagents]: https://developers.openai.com/codex/concepts/subagents
[codex-agents]: https://developers.openai.com/codex/guides/agents-md
[codex-features]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/features/src/lib.rs
[codex-shell]: https://github.com/openai/codex/blob/aea26afaee177d3fe40721ef261a29f89879d505/codex-rs/core/src/tools/handlers/shell_spec.rs
[codex-web]: https://developers.openai.com/codex/web-search
[codex-security]: https://developers.openai.com/codex/agent-approvals-security
[codex-hooks]: https://developers.openai.com/codex/hooks
[codex-mcp]: https://developers.openai.com/codex/mcp
[opencode-snapshot]: https://github.com/anomalyco/opencode/tree/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5
[opencode-todo]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/todo.ts
[opencode-agent-source]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/agent/agent.ts
[opencode-task]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/task.ts
[opencode-context]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/session/instruction.ts
[opencode-web]: https://github.com/anomalyco/opencode/tree/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool
[opencode-shell]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/shell.ts
[opencode-truncation]: https://github.com/anomalyco/opencode/blob/14f0bf64a19493110b51f5fdeb9c1c1bba5dd3f5/packages/opencode/src/tool/truncate.ts
[opencode-lsp]: https://opencode.ai/docs/lsp
[opencode-permissions]: https://opencode.ai/docs/permissions
[opencode-plugins]: https://opencode.ai/docs/plugins
[opencode-mcp]: https://opencode.ai/docs/mcp-servers
[opencode-tui]: https://opencode.ai/docs/tui
[claude-tools]: https://code.claude.com/docs/en/tools-reference
[claude-tasks]: https://code.claude.com/docs/en/agent-sdk/todo-tracking
[claude-permissions]: https://code.claude.com/docs/en/permission-modes
[claude-memory]: https://code.claude.com/docs/en/memory
[claude-subagents]: https://code.claude.com/docs/en/sub-agents
[claude-teams]: https://code.claude.com/docs/en/agent-teams
[claude-commands]: https://code.claude.com/docs/en/commands
[claude-interactive]: https://code.claude.com/docs/en/interactive-mode
[claude-checkpoints]: https://code.claude.com/docs/en/checkpointing
[claude-hooks]: https://code.claude.com/docs/en/hooks
[claude-mcp]: https://code.claude.com/docs/en/mcp
[claude-chrome]: https://code.claude.com/docs/en/chrome
[pi-overview]: https://pi.dev/docs/latest/usage
[pi-extensions]: https://pi.dev/docs/latest/extensions
[pi-providers]: https://pi.dev/docs/latest/providers
[pi-containers]: https://pi.dev/docs/latest/containerization
[omp-snapshot]: https://github.com/can1357/oh-my-pi/tree/54e1a8c900d30e5b6185975ab02a4a923faf1717
[omp-overview]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/README.md
[omp-todo]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/tools/todo.md
[omp-task]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/tools/task.md
[omp-context]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/context-files.md
[omp-plan]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/packages/coding-agent/src/prompts/system/plan-mode-active.md
[omp-prewalk]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/packages/coding-agent/src/session/prewalk.ts
[omp-agent-hub]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/agent-hub.md
[omp-mcp]: https://github.com/can1357/oh-my-pi/blob/54e1a8c900d30e5b6185975ab02a4a923faf1717/docs/mcp-config.md
