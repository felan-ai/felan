# Savings metrics design

> **Status:** Implementation design. The generalized service and RTK producer
> are now implemented incrementally; decisions marked as open still require
> follow-up before expanding the producer set.

## Purpose

Felan should measure the economic effect of its optimizations, persist those
measurements across sessions, and report them in one place. The primary outcome
is estimated cost avoided. Token usage remains important supporting evidence,
but fewer tokens are not always cheaper and more tokens are not always more
expensive.

Extensions should be able to compare an expected baseline with the actual
outcome without owning pricing lookup, storage, session identity, aggregation,
or presentation.

RTK is an implementation detail of the RTK optimizer extension. The public
metrics model and user-facing reports should describe both sequential
optimization boundaries without exposing RTK's commands, database, or `rtk gain`
interface.

## Goals

- Report estimated cost savings for the current session, current project, and
  all locally retained Felan activity.
- Preserve token usage when it helps explain the cost calculation.
- Support optimizations that spend more tokens on a cheaper model.
- Let extensions report savings through one small, validated contract.
- Attribute every measurement to its extension automatically.
- Persist metrics through `AgentRuntime.storage()` without direct filesystem
  access from portable extensions.
- Remain safe when root sessions or subagents run concurrently.
- Resolve model usage to USD through Felan's active model catalog when pricing is
  available.
- Make baseline, pricing source, method, and evidence visible instead of
  presenting estimates as provider billing data.
- Store counters and bounded labels only, never raw prompts, tool output, file
  contents, or command text.

## Non-goals

- Reproducing or exposing `rtk gain` as a Felan feature.
- Making RTK a public metric source or user-facing accounting concept.
- Building a general telemetry or analytics platform.
- Claiming that catalog-price estimates equal an invoice, subscription charge,
  quota saving, or marginal cash saving.
- Persisting raw content so that measurements can be recomputed later.
- Team-wide or cloud-wide aggregation in the first implementation.

## Current behavior and gap

The RTK optimizer now reports both RTK command-output measurements and Felan
post-tool measurements through the shared savings service. The former RTK metric
subcommands have been removed; `/gain` is the only interactive savings report.

How the command-output optimizer obtains its baseline
and actual outcomes is a producer implementation concern, not part of the shared
reporting contract.

## Working decisions

These decisions reflect the current direction and should change only through an
explicit update to this document:

1. **RTK remains internal.** The RTK optimizer may use RTK internally to obtain
   measurements, but other packages and user-facing reports consume only Felan's
   savings contract.
2. **There is one measurement type.** Producers report a baseline outcome and an
   actual outcome. The central service resolves prices and calculates cost and
   optional token deltas.
3. **Extensions report; they do not persist.** The host-bound savings service
   supplies source, time, session, project, validation, storage, and aggregation.
4. **Agent storage is canonical.** Session and project identifiers are fields in
   the stored data, so one persistent agent-scoped store can answer every query.
5. **Reports are Felan-owned.** `/gain` and `felan gain` aggregate all producers;
   RTK must not retain a competing source of totals.

## Savings comparison

A measurement compares two outcomes for one optimization decision:

```text
baseline outcome without the optimization
actual outcome with the optimization
```

An outcome may contain model token usage, a directly known USD cost, or both.
The baseline may be observed from a controlled comparison or estimated from a
documented counterfactual. For example:

- output compaction can compare the estimated input cost of the original and
  compacted result on the same model;
- model routing can compare actual usage on a cheaper worker model with the cost
  of equivalent usage on the parent model; and
- an extension with a direct provider or service charge can compare USD costs
  without inventing token counts.

The producer owns the meaning and evidence for its baseline. It must report a
bounded method identifier that makes the comparison reproducible and must not
claim a baseline it cannot justify.

Signed cost deltas from independent optimization decisions are additive. Two
producers must not report the same decision. Sequential optimizations can overlap
if one baseline already includes another optimization, so the default report
must not sum measurements whose accounting ownership is ambiguous. How Felan
detects or prevents overlap beyond first-party ownership rules remains open.

## Extension reporting contract

Agent Core should expose the contract and bind a reporter to each extension. It
should not contain storage policy, RTK behavior, report formatting, or local CLI
code.

The proposed initial contract is deliberately narrow:

```ts
export interface SavingsMeasurement {
  /** Felan-owned category used for aggregation. */
  readonly category: SavingsCategory;

  /** Optional bounded extension-local operation slug within the category. */
  readonly operation?: string;

  /** Expected outcome without the optimization. */
  readonly baseline: SavingsOutcome;

  /** Outcome with the optimization enabled. */
  readonly actual: SavingsOutcome;

  readonly basis: {
    readonly kind: 'observed-comparison' | 'estimated-baseline';
    readonly method: string;
  };

  /** Number of optimization decisions represented by this measurement. */
  readonly calls?: number;

  /** Small, predefined dimensions only; no arbitrary metadata. */
  readonly dimensions?: {
    readonly tool?: string;
    readonly techniques?: readonly string[];
  };
}

export interface SavingsOutcome {
  /** Directly observed or independently calculated cost. */
  readonly costUsd?: number;

  /** Model usage from which Felan can calculate catalog-price cost. */
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly cacheWrite1h?: number;
  };
}

export type SavingsCategory =
  | 'output-optimization'
  | 'model-routing'
  | 'context-management'
  | 'other';

export interface SavingsReporter {
  report(measurement: SavingsMeasurement): Promise<void>;
}
```

The extension does **not** provide:

- extension/package identity;
- timestamp;
- session or project identity;
- calculated cost/token savings or percentage;
- a storage path; or
- arbitrary metadata.

Categories and dimension keys come from a Felan-owned registry so that reports
remain comparable. Operation, tool, and technique values are bounded lowercase
slugs; an extension's operation values are internally namespaced by its bound
package identity. The initial limits and category-extension process must be
specified with the implementation.

Each outcome must provide either a finite non-negative `costUsd`, or both a model
reference and finite non-negative token counts. Providing both lets the service
retain observed cost while also explaining usage. Cache token fields default to
zero. The bound reporter also validates registered categories, bounded slug
values, at most a small fixed number of techniques, and a positive call count.

The service resolves missing outcome costs at report time and calculates:

```text
savedCostUsd = baseline.costUsd - actual.costUsd
savedTokens = total(baseline.tokens) - total(actual.tokens)  # when both exist
```

Both deltas remain signed. An optimization can therefore save money while using
more tokens, or add cost while reducing tokens.

### Example: tool-result compaction

```ts
await pi.savings?.report({
  category: 'output-optimization',
  operation: 'post-tool-compaction',
  baseline: {
    model: currentModel,
    tokens: { input: estimateTokens(originalContent), output: 0 },
  },
  actual: {
    model: currentModel,
    tokens: { input: estimateTokens(compactedContent), output: 0 },
  },
  basis: {
    kind: 'estimated-baseline',
    method: 'utf8-bytes/4-ceil',
  },
  dimensions: {
    tool: event.toolName,
    techniques: outcome.techniques,
  },
});
```

### Example: cheaper-model routing

An extension can report a positive cost saving even when the actual route uses
more tokens. This example compares observed worker usage with an estimated
parent-model baseline; the service prices both outcomes:

```ts
await pi.savings?.report({
  category: 'model-routing',
  operation: 'delegate-to-worker-model',
  baseline: {
    model: parentModel,
    tokens: estimatedParentUsage,
  },
  actual: {
    model: workerModel,
    tokens: observedWorkerUsage,
  },
  basis: {
    kind: 'estimated-baseline',
    method: 'parent-model-counterfactual-v1',
  },
});
```

If the extension cannot estimate how many tokens the parent route would have
used, it can reprice the observed worker usage at the parent model's rates. That
measures the routing-price advantage, not the full counterfactual cost of running
without delegation, and the method identifier should make that distinction.

### Pricing support

The pinned Pi model surface already contains the required primitives:

- every `Model` has input, output, cache-read, and cache-write rates in USD per
  million tokens, with optional request-size tiers;
- every assistant `Usage` records input, output, cache-read, cache-write, total
  tokens, and calculated USD cost components;
- `calculateCost(model, usage)` applies model tiers and special cache-write
  pricing; and
- `ModelRuntime.getModel(provider, id)` resolves the active catalog entry.

The savings service should receive a host-provided model price source and reuse
the same cost calculation rather than asking each extension to duplicate pricing
logic. When an outcome already has an observed `costUsd`, that value is retained.
When it has only model usage, the service resolves the model and calculates cost.

Historical reports must not be repriced silently when the model catalog changes.
The persisted measurement therefore stores the resolved cost and a bounded price
snapshot or price-version fingerprint used at capture time. A separate explicit
"reprice at current catalog" report could be added later.

Version 1 uses USD only. Catalog cost is an API-equivalent estimate: subscription
plans, quotas, negotiated pricing, free tiers, and provider billing adjustments
may not have a linear marginal dollar cost. Reports must identify the price source
and show cost as unavailable when no trustworthy price can be resolved rather
than treating unknown pricing as zero.

### Reporting flow

For an extension, reporting remains one operation:

1. define the baseline and actual outcomes for the optimization it owns;
2. call `pi.savings.report()` with cost, model usage, or both; and
3. continue normal execution regardless of whether metrics persistence succeeds.

The bound service then:

1. adds producer, session, project, and capture-time identity;
2. validates the comparison;
3. resolves missing USD costs from the host model catalog;
4. snapshots pricing provenance;
5. computes signed cost and token deltas; and
6. updates the producer's durable aggregate writer.

Extensions never open the metrics store or query other producers. `/gain`,
`felan gain`, and future dashboards use the shared read-only query service.

### API ownership

Proposed ownership:

| Layer | Responsibility |
| --- | --- |
| `@felan-ai/agent-core` | Public measurement and reporter types; binds the reporting extension identity |
| `apps/tui` | Validation, pricing, persistence, aggregation, query and presentation; supplies root-session/project identity and implements `/gain` and `felan gain` |
| Producing extension | Defines its baseline and actual outcomes and calls `report()` |

Whether `pi.savings` is required or optional for hosts that have not adopted the
service is still open. An optional property is the safer compatibility starting
point; first-party Felan compositions can always provide it.

## Command-output optimization producer

The current RTK optimizer is one producer of the same measurement contract, but
RTK remains internal to that extension. The producer reports two sequential
stages when both occur:

- command-output optimization; and
- Felan post-tool compaction.

Summary reports use stable Felan categories such as `output-optimization` rather
than presenting RTK as a separate accounting system. Stored rollups retain a
host-bound producer ID, and detailed text and JSON reports can group totals by
the extension that produced them. The host resolves a friendly extension name
when available and falls back to the stable producer ID. This attribution does
not expose RTK's own command or database as a public accounting source.

The RTK stage reads a bounded JSON summary from one temporary RTK database per
root session and model. The database and SQLite sidecars are removed after the
segment is collected at session shutdown. Felan never reads RTK's global
history, and the temporary tracker is not exposed as a user-facing RTK command
or storage path.

The selected method for obtaining the RTK baseline and actual outcome is a
session/model-sharded `RTK_DB_PATH` tracker plus one bounded `rtk gain --format
json` query per shard at shutdown. Any implementation change must satisfy these
constraints:

- emit one cost comparison for each accounted operation or aggregate;
- isolate concurrent root sessions and unrelated RTK activity;
- avoid executing the original command a second time;
- remain correct for long-running Codex commands and `write_stdin` completion;
- associate estimated context-token changes with the model whose input pricing
  applies;
- route process and storage access through `AgentRuntime`; and
- never expose an RTK database or `rtk gain` requirement in the public contract.

The extension does not import RTK's global cumulative total. Each session/model
summary is converted into one `rtk-command-output` measurement; Felan's
post-tool measurement then covers only the remaining tool-result-to-model
boundary. RTK's temporary database may contain its own raw command history while
the session runs, but it is bounded to the session storage capture and removed
with its SQLite sidecars after shutdown collection. A resumed session can report
an unfinished segment; because these are indicative metrics, a rare duplicate or
missed report is acceptable. No RTK history is copied into Felan storage.

## Local persistence

### Storage scope

The proposed canonical root is:

```text
runtime.storage('agent')/savings/v1/
```

On the local TUI this resolves beneath:

```text
~/.felan/storage/agent/savings/v1/
```

Portable code uses the storage interface and never hardcodes this host path.
`storage('agent')` means all retained sessions for one Felan agent directory. It
does not imply synchronization across profiles, devices, or managed hosts.

Session data does not need a second physical copy in session storage. Every
stored aggregate includes an opaque `sessionScopeId`, allowing current-session
queries against the canonical agent store.

### Stored shape

The persistence layer stores validated rollups rather than raw content or one
file per tool call. Every bucket belongs to exactly one producer extension,
identified by the host-assigned `producerId`. The extension is one grouping
dimension, not the whole bucket: one extension can have separate buckets for
different days, projects, operations, models, and pricing methods. A writer
snapshot can have this shape:

```ts
interface SavingsWriterSnapshotV1 {
  readonly version: 1;
  readonly writerId: string;
  readonly sequence: number;
  readonly sessionScopeId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly buckets: readonly SavingsBucketV1[];
}

interface SavingsBucketV1 {
  readonly day: string;
  readonly projectKey: string;
  readonly producerId: string;
  readonly category: SavingsCategory;
  readonly operation?: string;
  readonly basis: 'observed-comparison' | 'estimated-baseline';
  readonly method: string;
  readonly tool?: string;
  readonly techniques?: readonly string[];
  readonly calls: number;
  readonly baseline: SavingsOutcomeTotalsV1;
  readonly actual: SavingsOutcomeTotalsV1;
}

interface SavingsOutcomeTotalsV1 {
  readonly costUsd?: number;
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cacheWrite1h?: number;
  };
  readonly priceSource: 'producer-reported' | 'model-catalog' | 'unavailable';
  readonly priceFingerprint?: string;
}
```

The service resolves and stores outcome cost before aggregation. Token components
are supporting totals. A bucket may combine measurements only when all grouping
dimensions match, including day, project, producer extension, category,
operation, model references, basis, dimensions, price source, and price
fingerprint. The query layer derives signed saved cost and optional token deltas
instead of persisting redundant calculated values.

### File layout and concurrency

`AgentRuntimeStorage` currently has no append, rename, locking, transaction, or
compare-and-swap operation. A single shared JSON or JSONL file would lose updates
when multiple sessions write concurrently.

The proposed layout gives each service instance a unique writer ID:

```text
savings/v1/
  writers/
    <writer-id>/
      <sequence>.json
```

For every update, a writer:

1. updates its bounded in-memory buckets;
2. writes a new immutable sequence file;
3. validates successful persistence; and
4. keeps the newest valid generation plus a fallback generation.

Readers select the highest valid sequence for each writer and sum writers. No
writer modifies another writer's files, so independent Felan processes do not
need a shared in-process lock. Stale generations can be pruned opportunistically.

This is the current proposal, not a final decision. Alternatives include unique
immutable event batches or adding an atomic storage primitive to `AgentRuntime`.

### Identity

- The local host should supply or derive an opaque stable root-session scope.
  Nested subagents must use the root session's scope.
- Project identity should be derived from the normalized runtime cwd without
  storing the absolute path by default.
- `producerId` is assigned from Felan's extension binding; the producer never
  supplies it.
- Writer IDs are random and unique to one service instance.

The exact project-key format and whether a human-readable project label is
stored are open privacy and usability decisions.

### Bounds and retention

Every implementation must define:

- maximum snapshot size;
- maximum bucket count per writer;
- maximum lengths and allowed characters for labels;
- maximum number of retained writer generations;
- handling of malformed or newer schema versions;
- retention or rollup behavior for finalized sessions; and
- explicit clear/export behavior.

Exact limits are intentionally not selected yet. Overall reporting and bounded
storage pull in opposite directions, so pruning must preserve durable rollups
rather than silently dropping totals.

Metrics persistence is fail-open for agent execution: a storage failure must not
change a tool result or fail the turn. The service should retain a bounded error
status so `/gain` can disclose that the report may be incomplete.

## Query and reporting

### Interactive command

Proposed commands:

```text
/gain                 current root session
/gain project         current project across sessions
/gain all             all retained local metrics
/gain details         detailed category/operation breakdown
```

The default report should use product categories rather than internal mechanism
names:

```text
Felan savings — current session

Output optimization          ~$0.42   138K fewer tokens
Model routing                ~$1.85    24K more tokens
Context management           ~$0.11     9K fewer tokens
──────────────────────────────────────────────────
Estimated cost avoided       ~$2.38

Measured decisions: 47
Price basis: model catalog, API-equivalent USD
```

Only categories with measurements are shown. The detailed view expands producing
extension, category, operation, baseline/actual model and usage, tool, technique,
price source, and method data. Measurements whose cost cannot be resolved appear
in a separate token-only section and are excluded from the headline USD total.
Negative values are shown as added cost rather than hidden or clamped to zero.

### Local CLI

Proposed initial CLI:

```text
felan gain
felan gain --project
felan gain --session <id>
felan gain --daily
felan gain --monthly
felan gain --format text|json
```

`felan gain` should read the agent-scoped store without creating a model session.
The default CLI scope—current project or all retained data—is still open.

### Programmatic query

The TUI-owned savings service should expose a read-only query API used by both
`/gain` and the local CLI. The output schema should include:

- selected scope and time range;
- first and last measurement times;
- calls, baseline cost, actual cost, and signed cost savings;
- optional baseline/actual token components and signed token impact;
- producer extension ID and host-resolved display name;
- category, operation, and optional tool/technique breakdowns;
- baseline method, evidence basis, price source, and price fingerprint represented;
- unresolved-price measurements; and
- incomplete or malformed-storage diagnostics.

The exact text and JSON schemas remain open until the storage and aggregation
semantics are agreed.

### Clear behavior

Persistent deletion is not exposed through RTK. If clearing is added to Felan
savings, it must require an explicit scope and confirmation for agent-wide data.

## Cost and measurement accuracy

Current RTK optimizer metrics use JavaScript string length divided by four. That
is not the same as UTF-8 byte measurement and should not become the shared
contract.

Content optimizers that do not have provider token counts may use the proposed
default estimator:

```text
tokens = ceil(UTF-8 bytes / 4)
```

Extensions that know observed token usage report it directly. Reports must
disclose when totals combine different token estimators, pricing snapshots, or
counterfactual methods.

Token estimates alone do not account for provider tokenization differences,
prompt framing, or future cache behavior. Catalog-derived USD values price the
reported token classes and model; they remain estimates rather than billing
records.

## Migration from current optimizer metrics

The former in-memory `OutputMetrics` implementation has been replaced rather
than mirrored:

1. report eligible tool-result measurements through the shared reporter;
2. stop clearing durable metrics on `session_start`;
3. remove the former RTK metric subcommands; and
4. report isolated RTK executable savings without importing upstream global
   history into Felan's store.

No migration of old Felan metrics is possible because they are not currently
persisted. Any report must state the earliest retained measurement time.

## Open questions

1. Should `pi.savings` be an optional service or a required Felan extension API?
2. What exact baseline will the command-output optimizer use for reliable
   command-optimization cost comparisons?
3. Which baseline methods are sufficiently defensible to contribute to the
   headline cost total, especially for model routing such as Prewalk?
4. What review and compatibility process adds a new Felan-owned category or
   dimension?
5. How should optimization decisions be linked so accidental overlapping cost
   comparisons can be detected?
6. Should `felan gain` default to the current project or all local data?
8. What retention and rollup policy preserves all-time totals while bounding
   files, bytes, and query cost?
9. Should project labels be stored, derived only at query time, or omitted for
   privacy?
10. Do imported, cloned, forked, and resumed sessions retain or receive new
    metric scope identities?
11. What should happen when persistence fails for part of a session?
12. Which clear/export operations are needed in the first release?
13. Should subscription-backed models show API-equivalent list-price savings,
    effective marginal savings, or both when the latter can be known?
14. How much pricing detail must be stored to audit historical calculations
    without retaining an unbounded model catalog snapshot?

## Proposed implementation stages

Implementation should not start until the contract and storage decisions above
are accepted.

1. Finalize the baseline/actual measurement, pricing, and query contracts with
   fixtures and examples.
2. Prototype writer-sharded storage against `AgentRuntimeStorage`, including
   concurrent writers and corrupt-generation recovery.
3. Add the host-bound reporter and migrate post-tool compaction as the first
   producer.
4. Add `/gain` and `felan gain` over the same query service.
5. Add internal command-output measurements in the owning optimizer extension.
6. Add model routing or another cost-oriented second producer before declaring
   the extension contract stable.
7. Document retention, privacy, baseline evidence, pricing semantics, and
   compatibility behavior.

## Review checklist

Before this design is considered accepted, reviewers should be able to answer:

- Can an extension report savings without knowing local storage or session IDs?
- Can concurrent root sessions write without losing or double-counting data?
- Can current-session, project, and overall reports use the same canonical store?
- Can a user understand what was measured without knowing RTK exists?
- Can an optimization report positive dollar savings while using more tokens?
- Can totals explain their baseline, price source, pricing snapshot, and time
  coverage?
- Are unresolved and subscription-priced measurements labeled honestly?
- Can storage remain bounded without silently erasing all-time totals?
- Can a failed or malformed metric record leave agent execution unaffected?
