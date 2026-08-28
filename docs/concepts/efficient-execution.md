# Efficient execution and savings

Felan's local coding agent is built to complete software work without treating
the largest model, the most context, or the fewest tokens as goals by
themselves.

## Correctness first

An optimization only counts when the task still succeeds. Felan's development
target is **cost per verified task**:

1. hold the task, starting repository, verifier, timeout, and environment
   equivalent;
2. preserve failed, timed-out, and incomplete attempts;
3. compare total cost across the attempts needed to obtain a verified result;
4. use token counts and latency to explain the outcome, not replace it.

The public [harness-bench](https://github.com/felan-ai/harness-bench) repository
contains the reproducible evaluation definitions. Published product claims need
representative repeated results; a single passing comparison is case evidence,
not a universal savings claim.

## Where Felan reduces waste

Felan has several independent efficiency boundaries:

- **Model routing:** Prewalk can hand the same conversation trajectory from a
  planner model to a configured implementation model instead of starting a new
  session with only a plan document.
- **Context control:** nested project instructions load where they apply;
  subagents receive bounded tasks; MCP tools are discovered lazily; web and
  document results are bounded and pageable.
- **Tool-output optimization:** RTK-backed command rewriting and Felan's
  post-tool compaction reduce noisy model input while protecting failures,
  complete JSON, and recoverable source output.
- **Explicit work state:** tasks, structured questions, retained subagent
  records, and local project memory keep decisions and progress available
  without relying on one opaque chat transcript.

Not every boundary produces a savings measurement today. User-facing totals
include only measurements reported by supported optimization producers.

## Reading a savings report

Use the interactive command or the standalone CLI:

```text
/savings
/savings project
/savings all
/savings details
```

```sh
felan savings
felan savings --project
felan savings --session <id>
felan savings --daily
felan savings --monthly
felan savings --format json
```

Savings are **estimated API-equivalent cost avoided**. A measurement compares
a baseline outcome without an optimization with the actual optimized outcome.
Its basis is either:

- `observed-comparison` — both outcomes come from a controlled comparison; or
- `estimated-baseline` — the producer supplies a documented counterfactual and
  method identifier.

Felan resolves model usage through its active model catalog when pricing is
available. Unpriced measurements are excluded from the USD total and make the
report incomplete. The JSON format retains each measurement's basis, method,
models, token usage, price source, and producer.

## What the estimate does not mean

The report is not:

- a provider invoice or account balance;
- a guarantee of lower subscription charges;
- a claim that every Felan feature saves money;
- proof that the current task passed its acceptance criteria; or
- evidence that one configuration is universally faster or cheaper.

Subscription users may experience an optimization as more work before a usage
limit rather than literal cash saved. API users may see a lower catalog-price
estimate without the same reduction on a negotiated or cached bill. Always
keep the pricing basis and task outcome with any published number.

## Related documentation

- [Savings metrics design](../maintainers/savings-metrics-design.md)
- [Local CLI](../user-guide/local-cli.md#savings)
- [Agents, tasks, and Prewalk](../user-guide/agents-tasks-and-prewalk.md)
- [Configuration](../user-guide/configuration.md#rtk)

