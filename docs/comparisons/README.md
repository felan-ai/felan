# Comparing Felan with local coding agents

Felan is not the same kind of product as every agent in this list. Some are
vendor clients, some are general-purpose coding-agent harnesses, and Pi is the
foundation Felan composes. These pages make the tradeoffs explicit instead of
turning them into a checkmark count.

## Choose a comparison

| Page | The central question |
| --- | --- |
| [Felan vs OpenAI Codex](codex.md) | Do you prefer Felan's portable host and task graph, or Codex's structured tools and OS-enforced sandbox? |
| [Felan vs OpenCode](opencode.md) | Do you prefer Felan's explicit host/resource boundary, or OpenCode's broad configurable local harness? |
| [Felan vs Claude Code](claude-code.md) | Do you want a portable extension layer and evidence workflow, or Claude Code's mature approvals, integrations, and team features? |
| [Felan vs Pi](pi.md) | Do you want Felan's batteries-included local host, or Pi's smaller extension-oriented foundation? |
| [Felan vs Oh My Pi](oh-my-pi.md) | Do you want Felan's portable host contracts and narrower policy, or OMP's very broad native tool surface? |

## How to read these pages

Each page follows the same decision-oriented structure:

1. a short answer describing who each product is for;
2. an explanatory at-a-glance table;
3. workflow differences with mechanism and consequences;
4. cases where Felan is the better fit;
5. cases where the alternative is the better fit;
6. migration, interoperability, and trust-boundary notes;
7. questions existing users are likely to ask; and
8. dated sources and a low-pressure next step.

The pages are not benchmarks, endorsements, or pricing comparisons. They cover
observable local terminal behavior and exclude model quality, separate web or
desktop products, IDE surfaces, team administration, and subscription pricing.
The [technical feature matrix](feature-matrix.md) contains the detailed
cross-agent inventory; [methodology](methodology.md) records reviewed versions,
commits, and official sources.

## Shared Felan starting points

- [Getting started](../getting-started.md)
- [Architecture](../concepts/architecture.md)
- [Runtime and security](../concepts/runtime-and-security.md)
- [Agents, tasks, and Prewalk](../user-guide/agents-tasks-and-prewalk.md)
- [Context and memory](../user-guide/context-and-memory.md)
- [Web, MCP, browser, and documents](../user-guide/web-mcp-and-browser.md)

All five pages use the same Felan baseline: local Felan `0.12.10` at commit
`abd4ee34ab2bc2289802af4d2a317b56239f44c5`, refreshed **2026-08-21**. The
competitor snapshots and official documentation dates are recorded separately
in [methodology](methodology.md). Capabilities change quickly; check the
linked official sources before treating a dated row as current.
