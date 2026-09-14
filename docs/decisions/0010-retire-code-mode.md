# ADR 0010: Retire code mode and nested tool invocation

> Status: Accepted
> Date: 2026-09-14
> Deciders: Felan maintainers
> Related: [ADR 0007](0007-compose-tools-through-local-code-mode.md), [Efficient execution](../concepts/efficient-execution.md)

## Context

Felan evaluated bounded local code mode against direct tool execution on
representative verified dataflow and structured migration tasks. Both arms
achieved equal correctness after grading normalization, but the code-mode arm
cost 14.52% more and used 14.06% more prompt tokens. It also introduced a
separate guest runtime, nested dispatch contract, audit surface, and additional
maintenance burden without demonstrated savings.

## Decision

Retire `@felan-ai/ext-run`, the `run_code` tool, and Agent Core's public nested
tool invocation contract. Direct tools remain the supported mechanism for
individual calls and multi-step work; model orchestration and existing output
compaction, routing, and subagent features remain available.

## Alternatives Considered

- Keep code mode: rejected because representative equal-quality tasks showed
  higher cost and prompt-token use.
- Retain the generic nested dispatcher for future extensions: rejected because
  it preserves public API and maintenance cost without a current consumer.
- Keep a hidden compatibility extension: rejected because it would retain an
  unused security and packaging surface.

## Consequences

- Agent Core moves to `0.7.0` because the public nested invocation API is
  removed; surviving extensions move to the compatible peer range.
- Users use direct tools for calls that previously could be composed in code;
  there is no migration requirement for generated code-mode scripts.
- The QuickJS dependency, nested authorization/audit path, and dedicated
  benchmark surface are removed, reducing security and maintenance burden.
- Future cost-reduction extensions must demonstrate representative,
  correctness-gated benchmark evidence before merge.
