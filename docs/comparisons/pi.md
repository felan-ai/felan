# Felan vs Pi

> Last verified: 2026-08-21. Felan baseline `0.12.10` at
> `abd4ee34ab2bc2289802af4d2a317b56239f44c5`; Felan pins the reviewed
> `@earendil-works/pi-*` packages at `0.84.3`.

## Short answer

Pi is the smaller, highly extensible coding-agent foundation: it provides the
model/session/extension primitives and leaves many workflows to the host or to
extensions.

Felan is a host and extension layer built on that foundation. Choose Felan when
you want a batteries-included local application with a shared task graph,
asynchronous subagents, Prewalk, local-first memory, bounded web research,
OAuth-only MCP, browser/document integrations, and explicit resource policy.
Choose Pi when you want to assemble a smaller or more custom agent surface and
own the host decisions yourself.

## At a glance

| Dimension | Felan | Pi |
| --- | --- | --- |
| Product shape | Local `felan` host plus portable Felan extensions and Agent Core | Extensible coding-agent foundation and host APIs |
| Tasks and agents | Built-in shared dependency graph, bounded async subagents, local navigator, and Prewalk | No core task graph; subagents, todo, and plan behavior are extension/host concerns |
| Context | cwd instruction file plus progressive nested context and explicit Agent Skills | Host/extension-defined context and resource loading |
| Memory | Local-first Markdown memory with host-owned checkpoint/dream/publication lifecycle | No equivalent Felan memory contract in Pi core; extensions can define one |
| Web and MCP | Bounded web evidence tools and local OAuth-only remote MCP gateway | Web/MCP are integrations or extensions supplied by the host |
| Local policy | Filters ambient Pi packages, extensions, prompts, project settings, and themes | Host chooses resource discovery and policy |
| Providers | Consumes the pinned Pi model/provider surface and adds Felan model-specific adapters | Provides the underlying model/provider APIs and configuration primitives |
| TUI | Local Felan groups tool activity, exposes task/agent/process overlays, and owns the footer/presentation | Pi TUI primitives and default host presentation |

See the [feature matrix](feature-matrix.md), especially its [planning](feature-matrix.md#planning-tasks-and-agent-coordination),
[context](feature-matrix.md#context-memory-and-sessions), and
[extensibility](feature-matrix.md#extensibility-mcp-safety-and-models) sections.

## How the workflows differ

### Felan packages a host policy; Pi leaves it to the host

Felan's local TUI owns credentials, settings, storage path mapping, model scope,
built-in allowlisting, dependency onboarding, local subagent execution, and
presentation. It filters ambient Pi resources and exposes only explicit Felan
skills, agents, and cwd instructions.

Pi is valuable precisely because those choices remain open. A Pi application
can select a different extension discovery policy, storage model, UI, or
approval system. The tradeoff is assembly work: Pi gives you primitives; Felan
gives you a maintained local composition.

### Felan's task graph and Prewalk are product workflows

Pi's core does not provide Felan's dependency-aware task state. Felan's tasks
carry prerequisites, acceptance criteria, worker claims, and verified results;
Prewalk then uses that graph as part of a same-session planner-to-implementer
handoff. A Pi host can build a different workflow, but it is not present in the
core feature set being compared.

### Felan adds explicit external-content boundaries

The Felan web, MCP, browser, and document extensions all bound or mark external
content as untrusted and route host actions through explicit adapters. The local
MCP host owns OAuth credentials and callbacks, and web access blocks private
network targets by default.

Pi's general extension model lets a host add any of these surfaces, including
ones with different trust assumptions. Pi is therefore not “less capable”; it
leaves the application author responsible for choosing and documenting the
boundary.

### The relationship is composition, not a source fork

Felan consumes pinned Pi packages and re-exports the shared Pi composition
surface through Agent Core. It keeps its own base prompt, runtime contracts,
host policy, and extensions without carrying a divergent Pi source tree.

## Choose Felan when...

- you want to install one local application instead of assembling a host;
- task dependencies, child-agent control, and Prewalk are central workflows;
- local-first memory and bounded evidence retrieval should be first-party;
- you want explicit host/runtime/security ownership across local and managed
  deployments; or
- you want Pi's provider/session foundation with Felan's product layer on top.

## Choose Pi when...

- you are building a custom host, UI, or orchestration workflow;
- you want to choose your own extension discovery, settings, and approval policy;
- Felan's fixed local resource boundary is too narrow for your application; or
- you want the smallest foundation and are comfortable owning integrations and
  lifecycle behavior yourself.

## Migration and interoperability

Felan uses the pinned Pi extension and session APIs, but it is not a drop-in
runner for arbitrary Pi project configuration. The local host intentionally
filters ambient Pi extensions, prompts, packages, project settings, and themes.

Portable extension authors can target `@felan-ai/agent-core` and the Felan
extension contracts, then bind host behavior explicitly. A Pi extension that
assumes direct host I/O, ambient discovery, or Pi-specific settings may need an
adapter or a deliberate port.

Repository instruction files and explicit Agent Skills can be shared when their
host loading rules match, but do not assume identical command, storage, or
credential behavior.

## Trust and data boundaries

Felan documents and tests a narrower local policy, but the local host still has
current-user filesystem/process permissions and is not a sandbox. Pi itself is
a foundation; the host application defines whether it is sandboxed, what
extensions are loaded, how credentials are stored, and how external content is
marked.

See [Felan architecture](../concepts/architecture.md),
[runtime/security](../concepts/runtime-and-security.md), and Pi's
[containerization guidance](https://pi.dev/docs/latest/containerization).

## Questions Pi users ask

### Is Felan a Pi fork?

No. Felan wraps pinned `@earendil-works/pi-*` packages and composes them with
its own Agent Core, host runtime, and extensions.

### Can I use a Pi extension unchanged?

Not automatically in the local TUI. Felan loads only source-controlled built-
ins. A compatible extension can be explicitly composed by a host, but it must
respect the Agent Runtime and host-adapter boundaries.

### Does Felan replace Pi's provider support?

No. Agent Core exposes the pinned Pi provider/model composition surface. Felan
adds host policy and model-specific feature behavior around it.

## Sources and methodology

This page uses the dated [feature matrix](feature-matrix.md) and
[comparison methodology](methodology.md). Pi references include its [usage and
feature inventory](https://pi.dev/docs/latest/usage),
[extension guide](https://pi.dev/docs/latest/extensions),
[provider guide](https://pi.dev/docs/latest/providers), and
[containerization guide](https://pi.dev/docs/latest/containerization).

## Try Felan

```sh
npx @felan-ai/felan
```

Start with [Getting started](../getting-started.md) or read the
[Agent Core package reference](../../packages/agent-core/README.md).
