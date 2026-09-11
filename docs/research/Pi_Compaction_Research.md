# Compaction methods for long-running coding agents

**Recommendation: improve Pi’s memory architecture before replacing its summarizer.** Keep a structured checkpoint and recent working context, give the agent bounded access to original history, and protect active constraints and verified task state from repeated rewriting. Use cheap pruning to reduce tool-output noise before another full compaction becomes necessary.

Pi already has structured, iterative summaries, safe recent-history retention and cumulative file tracking. Several extension READMEs describe the native baseline as unstructured or say it permanently deletes old messages; that is not an accurate description of the current implementation. Compaction removes history from the active model context, not from Pi’s session log. [1][2][4][10]

## Deployment choices

| Choice | Recommendation | Reason |
| --- | --- | --- |
| Lowest-risk starting point | Native Pi + pi-vcc recall, with its override disabled | Adds usable history retrieval without replacing the native summary path. |
| Best replacement candidate to test | pi-smart-compact | Adds deterministic extraction, verification, a continuity ledger and scoped recall. |
| Alternative memory architecture | pi-blackhole; pi-lcm for very large histories | Observational memory or hierarchical retrieval, with more operational complexity. |

The first two choices address different risks. Native-plus-recall minimizes integration change; verified compaction aims to improve what survives. Neither recommendation is a claim that an extension has already beaten native Pi on representative long-running coding tasks. The reviewed public evidence does not establish that head-to-head result. [4][7][8][9][10]

## Effectiveness criteria

A successful compaction lets the next agent step remain correct: preserve the user’s active requirements, know what is actually implemented and tested, avoid repeating rejected approaches, recover exact details when needed, and continue without overflow or protocol errors. A smaller prompt is useful only when it lowers the cost of completing the task without unacceptable damage.

**Assessment scope.** Sources were checked through September 10, 2026. Implementation descriptions use current documentation and inspected repository snapshots. Numerical effectiveness scores below are engineering judgments, not measured success rates. Published experiments are reported separately. No extensions were installed and no paid model evaluation or user-session replay was performed.

**Bottom line.** pi-vcc is a compelling fast compiler and recall layer, not a demonstrated universal quality upgrade. For a serious Pi optimization effort, compare a native-plus-recall baseline against verified compaction and a cache-aware pruning variant before adopting a more elaborate memory system.

# 1. Pi’s native compaction baseline

Pi compacts the older conversation span and retains a recent suffix. Its default reserve is 16,384 tokens; the recent-history target is 20,000 tokens. The trigger is contextTokens > contextWindow − reserveTokens. Current Pi can compact between tool batches within the same run and resume, rather than requiring an extra synthetic user instruction. [1][2]

```
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

## Structured, incremental state

The initial prompt requests goals, constraints and preferences, completed/in-progress/blocked work, decisions and rationale, next steps, and critical context. On subsequent compactions the model receives the previous summary plus newly evicted messages and is asked to update the same structure. Read and modified file paths also have a programmatically extracted representation. This is already close to the anchored-iterative design advocated by other agent vendors. [2]

The update prompt asks to preserve existing information but also permits removal when something is no longer relevant. That is a judgment call, not a retention guarantee. A one-time constraint, subtle rejected approach or unresolved dependency can still disappear or be reinterpreted. Tracking a path also does not prove the current contents, correct implementation or latest test outcome.

## Boundaries and recovery

Pi stores a compaction checkpoint and the first retained entry identifier. Older entries remain in the session history. Long individual user turns can be split, with separate treatment of the earlier turn prefix. Tool calls and their results must remain in valid order; a cut cannot strand a result without its call. Branch summarization is a separate operation from ordinary compaction. [1][2]

**A concrete fidelity bottleneck:** the documented serializer limits each tool result to 2,000 characters before summarization. A decisive assertion or stack-trace line outside that prefix can be absent from the summarizer’s input. A replacement should extract diagnostic evidence before this truncation, rather than merely rewriting the summary prompt. [1]

## Tuning implications

Start with the native retained-tail budget as the control. Measure pressure and damage before increasing compaction frequency. A longer tail preserves immediate reasoning but leaves less room for the next phase; earlier compaction reduces prompt growth but introduces more rewrite cycles and cache resets.

Do not treat reserveTokens as a pure percentage-threshold knob. In inspected source, the summary output cap is min(floor(0.8 × reserveTokens), model output limit). Large reserves can therefore alter summary-generation limits as well as trigger timing. Current per-model overrides are useful, but trigger and output budgets should ideally be independently controlled in a custom policy. [2]

# 2. Method effectiveness scorecard

Scores prioritize long-running coding continuity rather than compression ratio: continuation quality 40%, critical-state fidelity 25%, resilience/recoverability across repeated compactions 20%, and end-to-end cost/latency 15%. Component judgments use a 1–10 scale; totals are rounded to the nearest 0.5. A half-point difference is not statistically established.

| Method / deployment pattern | Score | Evidence confidence | Main trade-off |
| --- | --- | --- | --- |
| Protected state + structured summary + raw recall + pruning | 9.0* | Medium for components; low for the whole | Best target architecture, but the integrated stack is a proposal. |
| Verified structured compaction + continuity ledger + recall | 8.5 | Low–medium | Strong integrity design; verifier coverage is not semantic correctness. |
| Observation masking + periodic structured compaction | 8.5 | Medium | Strong coding-cost evidence; stale facts and retained action growth still need handling. |
| Hierarchical summaries + source-addressable retrieval | 8.0 | Low–medium | Scales retrieval; adds calls, storage and “what should I search?” burden. |
| Observational memory + deterministic brief + recall | 8.0 | Low–medium | Captures decisions before eviction; memory workers can drift or lag. |
| Provider-native compaction in its supported stack | 8.0 | Low–medium comparative evidence | Good integration potential; portability and inspectability vary. |
| Structured iterative summary + raw recent tail: native Pi | 7.5 | Medium | Solid baseline, but old semantic state still depends on a lossy summary. |
| Deterministic ranked brief + raw recent tail + recall: pi-vcc | 7.0 | Low–medium | Very cheap compaction; heuristic selection may miss causal/implicit state. |
| FIFO / recent-turn window alone | 4.5 | Medium | Cheap and bounded, but deliberately forgets older requirements. |

*The 9.0 score is an architectural assessment, not a product benchmark. Methods overlap and can be combined. “Observation masking” removes or replaces old tool observations while preserving other useful trajectory information; it is not indiscriminate deletion of the entire old conversation.

Evidence confidence concerns downstream effectiveness, not whether a feature exists. Public source is enough to verify a mechanism; it is not enough to prove that mechanism improves completion rates. In particular, pi-smart-compact, pi-blackhole and pi-lcm should not inherit experimental results from related papers as if those exact extensions had been evaluated. [7][9][10][14][17]

## Ranking rationale

The highest-scoring design separates obligations, task state, working context and archival evidence instead of asking one short summary to serve all four purposes. The middle group makes increasingly useful trade-offs between semantic compression and recoverability. The weakest standalone policy forgets according to age rather than relevance. An asynchronous scheduler is not a separate fidelity method: it changes when the existing compactor runs.

# 3. Empirical evidence and limitations

## Published coding benchmark: observation masking

The Complexity Trap evaluates SWE-agent on SWE-bench Verified. Its Qwen3-Coder 480B results are below. Masking approximately halved cost; the small solve-rate differences do not establish a quality win. Both compaction methods harmed solve rate in the Gemini 2.5 Flash thinking configuration. Model dependence matters. [14]

| Qwen3-Coder 480B strategy | Solved | Mean cost / task |
| --- | --- | --- |
| Raw history | 53.4% | $1.29 |
| Observation masking | 54.8% | $0.61 |
| LLM summarization | 53.8% | $0.64 |

## Factory: summary quality, not completed-task superiority

Factory’s December 2025 vendor evaluation used production-session probes. Its structured iterative approach scored 3.70/5 overall, versus 3.44 and 3.35 for the compared Anthropic/OpenAI methods; artifact tracking was weak for all three. The data are private and the metric is judged probe quality, not final coding success. These historical comparisons do not rank September 2026 provider implementations. [15]

## pi-vcc: an internal compiler comparison

The published comparison covers 790 non-empty sessions and compares the ranked brief with pi-vcc’s own 0.3.18 baseline—not native Pi. Paired median weighted-fact recall was unchanged, with a −0.7 percentage-point mean change. Typical brief size fell 11%; corpus-wide bytes fell 35%. The latter is not a 35% saving for the typical session. [6]

## Constraints: retention is not one universal percentage

CompInt reports severe constraint loss in several configurations and over 90% retention with a separate constraint extractor. Its results also vary sharply: the Pi prompt with GPT-5.4-mini retained 88.4% of injected constraints in the Hermes-Agent condition, but only 6.7% in WildChat. These are controlled retention/probe tests, not full Pi coding rollouts; proprietary-model tests also used different context lengths and fewer trials. The takeaway is to protect scoped constraints, not to assign every modern compactor the paper’s aggregate 17% headline. [16]

## Hierarchical memory: useful but indirect evidence

The LCM paper reports Volt outperforming Claude Code on OOLONG aggregation tasks. That system also uses engine-managed map/reduce, so the evaluation does not isolate the summary DAG. It neither benchmarks pi-lcm nor demonstrates better software-task completion after repeated Pi compactions. [17]

**Evidence gap:** none of these sources supplies a controlled, current comparison of native Pi, pi-vcc, pi-smart-compact, pi-blackhole and pi-lcm continuing the same long coding tasks through many compaction cycles. The scorecard is therefore a prioritization tool for testing, not an empirical leaderboard.

# 4. pi-vcc: strengths, limits and best use

pi-vcc builds a compact transcript algorithmically rather than calling a summarization model. Its inspected hook imports compileRanked. Semantic sections extract goals/scope changes, file changes, commits, outstanding context and preferences, while tool actions become brief references. Sections are merged and re-capped instead of growing without bound. [4][5]

## Strengths

It removes summarizer latency and summarizer API spend. It also avoids new prose hallucinations introduced by an LLM rewriting the transcript. Exact paths, command families and commits are natural candidates for deterministic handling. That makes the method attractive for tool-heavy sessions whose detailed evidence is easy to recover.

The vcc_recall tool reads Pi’s original session JSONL, with active-lineage search by default. Keyword ranking, regex and pagination make the archive practical to query. Explicit scope:"all" includes other lineages; earlier sessions are outside this tool’s stated scope. Retention in storage and successful retrieval are distinct from keeping the information in the active prompt. [4]

## Limitations

Regex extraction and ranked snippets are not a complete model of the task. “We must not use solution X because it breaks tenant isolation” contains a relationship and a negative constraint that a path/command-oriented brief may fail to preserve. A deterministic compiler does not invent new prose, but selection, truncation and stale-state merging can still produce a misleading view.

A retrieval tool repairs omissions only when the agent notices a gap and searches effectively. Facts such as “do not touch this interface” should not depend on the model remembering to recall a forgotten instruction. Likewise, a search result from a prior branch must not be silently promoted to current workspace truth.

## Benchmark interpretation

The current benchmark weights exact extracted facts: failed commands, commits, modified files, verification commands and other events. Ranked briefs improve fact density and reduce duplication, but the reported out-of-sample fact recall for huge transcripts is only about 17–20% at the bounded brief size. That is a property of the brief, not loss of the raw archive. The metric does not test whether the resumed agent finishes correctly or preserves the rationale behind decisions. [6]

## Recommended posture

**Use pi-vcc as a recall layer first, then test its compiler separately.** Set overrideDefaultCompaction:false so /compact and native automatic compaction remain Pi-owned. The explicit /pi-vcc command still invokes the extension’s compactor. This gives a useful control arm: better retrieval without changing both retrieval and summarization at once. [4]

For a full replacement trial, preserve a budgeted recent tail, retain pinned constraints elsewhere, and test single-prompt runs as well as multi-message chats. The current hook includes token-budget fallback cuts for oversized/no-anchor tails. It also suppresses its own automatic “continue” on Pi versions that already self-resume, avoiding duplicate continuation turns. [5]

# 5. Verified compaction and observational memory

## pi-smart-compact: the strongest fidelity-oriented candidate

Its current main-branch design follows Extract → Explore → Synthesize → Verify. Deterministic extraction creates a fact inventory before synthesis. The pipeline can use a single summary or hierarchical synthesis, repairs recognized gaps, and rejects unresolved verification gaps before staging/apply. Unsupported high-risk outcome claims such as successful tests or deployment are removed unless evidence supports them. [7]

A continuity ledger carries decisions, constraints, unresolved errors and open loops forward. Goal wording changes alone do not retire unresolved facts. Scoped SQLite FTS5 recall and a file-linked context graph add project-level retrieval, while explicit manual memories require user confirmation. These mechanisms address gaps that a different summary prompt alone cannot reliably address.

**What “verified” does not mean:** extraction has a recall ceiling. A verifier can prove coverage of the items it detected without noticing a missing implicit requirement. A reported 100/100 verification score is not proof that all semantics survived, that tests genuinely cover the requested behavior, or that the resumed agent will act correctly. False resolution and stale evidence still require adversarial tests.

Current modes are fast, balanced and thorough. Balanced documents a 6k summary and 20k recent tail, with bounded multi-call budgets. Its default 60% context gate is an eligibility condition when Pi initiates compaction, not automatically an independent trigger at 60%; settled triggering is a separate option. The agent-facing smart_compact tool stages a candidate for a later native compaction rather than mutating an active turn. [7]

The published August 6 provider probe uses only three short scenarios per model and its own deterministic verifier. It explicitly warns that these are not production-sized compaction windows and does not change routing automatically. This is useful operational evidence, but not a native-Pi quality comparison. [8]

## pi-blackhole: capture memory before the big cut

pi-blackhole combines a VCC-style structural brief with an Observer, Reflector and Dropper. Workers extract timestamped observations, distill durable reflections and trim the active memory pool. Its recall interface links observations/reflections back to source evidence and defaults to the active lineage. This is a practical hybrid rather than a purely algorithmic memory system. [9]

The important distinction is cost accounting: the final structural compaction does not make an LLM call, but the memory workers do. Their extraction and reflection can also be wrong, incomplete or delayed. Evaluate worker lag, failed-provider recovery and whether early constraints survive reflection and dropping, not just the visible /blackhole latency.

The README explicitly warns that standalone pi-vcc and pi-observational-memory conflict with blackhole. It also supports handing ordinary compaction back to Pi while retaining memory features. Those are separate configurations to test, not evidence that all memory extensions can safely be stacked. [9]

# 6. Hierarchical recall, pruning and scheduling

## pi-lcm: a navigable hierarchy instead of one flat checkpoint

pi-lcm stores messages in SQLite with full-text search, groups raw spans into leaf summaries, and condenses those into higher-level summaries. The assembled active view has a token budget. The model can search, inspect a summary node and expand back into original messages using lcm_grep, lcm_describe and lcm_expand. [10]

This has a clear advantage when the history contains many completed phases: an index can expose the structure of the archive without putting every fact in one flat paragraph. But the active summaries remain lossy. Retrieval introduces additional turns, and the model may not know which node contains an omitted dependency.

The published defaults include 4k-token leaf chunks, an 8k assembled-summary budget and bounded expansion. The README describes project-level, cross-session storage and fallback summarization models. Confirm current Pi compatibility, active-branch isolation, model-routing/privacy policy, restart recovery and budget enforcement before deploying. Explicit branch-safety evidence was insufficient in the reviewed README; do not assume project scoping implies branch correctness. [10]

“Lossless” should describe recoverability of archived originals, not a guarantee that the model remembers everything. Pi already retains original session entries; the useful addition is hierarchical indexing and model-accessible drill-down, not rescuing data that native Pi destroyed.

## pi-condense / pi-context-prune: reduce the tool-output load

These extensions operate on tool-output history rather than replacing the entire session summary. pi-condense provides compact batch summaries and short references, with context_tree_query to recover originals. It adds cache-aware batching, protected outputs, deduplication and oversized-output handling. This is not identical to the zero-LLM observation-masking method in the coding benchmark. [11][12]

For a long autonomous run, trigger configuration is crucial: pi-condense’s default final-text-reply trigger can wait until the run is essentially finished. Its documented pressure/turn-budget options permit mid-run flushing. It is off by default, and its synchronous summarizer calls add latency. Test it alongside native compaction as a separate arm before combining it with other context transformations. [11]

## pi-async-compaction: optimize the pause, not the information

This family prepares native-style summaries ahead of the hard boundary and applies them when safe. The main expected gain is reduced blocking at compaction time, not better retained semantics. Speculative summaries can become stale or be discarded, and the new messages after the snapshot must remain intact. Treat it as a scheduling optimization after the chosen memory representation proves reliable. [13]

**Order of investment:** first preserve obligations and recoverability; then reduce repeated tool-output tokens; only then hide compaction latency. Otherwise faster compaction can simply make a lossy workflow fail more smoothly.

# 7. Context management in other agents

## Claude Code: clear tool history before summarizing

Current Claude Code documentation describes clearing older tool outputs first, then summarizing when necessary. It recommends persistent rules in CLAUDE.md, focused compaction instructions, and isolated subagent contexts. The transferable pattern is layered context management: stable instructions, disposable observations, then semantic compaction—not one universal summary mechanism. [20]

## Anthropic API: selective edits and server-managed summaries

The API separately offers tool-result/context editing and server-side compaction. The latter emits a summary-bearing compaction block and continues from it. This reduces client orchestration, but is distinct from a Pi extension returning a normal text checkpoint. Do not assume every Claude Code detail is implemented by the same public API strategy. [21][22]

## Codex / OpenAI: provider-native compacted state

OpenAI describes Codex moving beyond client-written text summaries to native compaction. The Responses API can compact at a configured server threshold or through a standalone endpoint. The returned state includes an opaque encrypted compaction item and can retain other items. The canonical standalone output should be passed forward as returned, not reduced to a string. [18][19]

For Pi, this is an adapter/integration project rather than a new summary prompt. Preserve provider-specific items in session persistence, verify continuation and model-switch behavior, and keep a portable, inspectable task ledger. Encryption does not imply lossless reconstruction of the old transcript.

## OpenCode: checkpoints and selective compression

The documented V2 architecture uses checkpoints containing a summary and a retained tail while keeping durable historical messages. This is a useful persistence design, but V2 documentation should not be generalized to every installed OpenCode version. [24]

The DCP plugin lets the model compress closed spans or, experimentally, individual messages. It combines this with duplicate-call cleanup and removal of old failed-call input payloads while preserving errors. Current cleanup is grouped with compression to limit repeated cache disruption. Its README says new development has shifted toward Sleev; DCP is a pattern reference, not automatically the freshest deployment choice. [25]

## Factory and long-running harnesses

Factory’s anchored iterative approach reinforces structured task-state updates; Pi already shares that broad pattern. Its artifact-tracking weakness motivates a separate index rather than assuming more prose solves every omission. [15]

Anthropic’s long-running harness design adds an initializer, explicit feature checklist, progress notes, git checkpoints and verification across successive working contexts. This is a complementary solution: a long-running job can span bounded episodes while preserving validated external state. In Pi, task-boundary handoffs and focused child agents can reduce how much context must ever be compacted. [23]

**Transferable lesson:** stable obligations and verified workspace state should outlive any particular prompt window. Provider-native state, human-readable summaries and retrieval indexes are alternative working-memory representations, not substitutes for that durable contract.

# 8. Recommended Pi architecture

The following is a proposed design, not an extension tested in this assessment. It keeps Pi’s run/session machinery and adds explicit policies around what may be compressed. A first implementation should favor a small number of well-scoped components over several competing compaction plugins.

## Four distinct memory layers

| Layer | Contents | Retention policy |
| --- | --- | --- |
| Protected obligations | Active user constraints, approvals, acceptance criteria | Keep exact text or a checked representation. Retire only with explicit scope/override evidence. |
| Verified working state | Goal, open loops, decisions, changed artifacts, latest test evidence, next action | Update incrementally. Record provenance and freshness; do not equate a mention with proof. |
| Recent working context | Latest complete exchanges and current investigation | Retain a token-budgeted suffix. Prune only finalized, safe-to-evict observations. |
| Historical evidence | Raw session entries, original outputs, previous state revisions | Append-only archive with branch-aware search, stable references and bounded expansion. |

## Use Pi’s extension lifecycle without rewriting its history

Pi’s context hook receives a deep copy of the outgoing messages and supports non-destructive filtering. That is the appropriate seam for request-view masking. session_before_compact can supply a checkpoint at Pi’s prepared cut; session_before_tree is a separate branch-transition seam. Keep persistent originals separate from the transformed request. [1][3]

Before summarization, extract constraints and exact diagnostic facts from the full eligible events. Then ask the model to update only the mutable working-state fields. Validate required IDs, unresolved items and evidence links; a missing mandatory item should retain its previous state or fail the custom compaction rather than silently disappear.

Apply the new state only when the matching compaction succeeds. On abort/failure, keep the prior checkpoint and archive available. Cancel stale work on session switch; validate the original branch/cut when applying any speculative summary. Do not send a second “continue” when core Pi already resumes the run.

## Prevent false current-state claims

Store a test command, exit status, result entry, timestamp and workspace revision/diff fingerprint together. “Tests passed” from an earlier commit is historical evidence, not proof about the current tree. A file list should distinguish planned, edited, created, deleted and subsequently reverted states. Shell-side changes require reconciliation, not only parsing built-in edit tools.

## Keep retrieval useful and bounded

Return source IDs, branch/session identity, age and a small excerpt. Start with exact/keyword search for paths and errors; add semantic retrieval only when misses justify it. Put pointers to omitted areas in the summary. Keep obligations in active state rather than relying on recall, and cap the number and token volume of expansions per step.

# 9. Practical rollout

## Control arm: native Pi plus history recall

Install pi-vcc, then merge the flag below into its configuration before running the comparison. This keeps the native /compact and automatic path while exposing recall. Record the installed package version; the inspected repository package metadata declared 0.7.2. [4][26]

```
pi install npm:@sting8k/pi-vcc

# ~/.pi/agent/pi-vcc-config.json
{
  "overrideDefaultCompaction": false
}
```

Maintain a small session-scoped checkpoint file or structured ledger. Do not put temporary constraints into a permanent global instruction file. Rehydrate active state into the working context at the next episode/compaction boundary; merely writing a file does not ensure the model will read it.

## Candidate arms

**A — fidelity:** run pi-smart-compact alone as the compaction owner, starting with balanced mode and explicit provider routing. Keep its native fallback available. Do not interpret its coverage score as the experiment’s outcome metric.

**B — economy:** keep native Pi and add cache-aware tool-output pruning. For pi-condense, explicitly enable it and configure an appropriate mid-run pressure trigger for autonomous jobs. Measure summary costs and cache misses, not just the number of tokens it removes.

**C — memory architecture:** compare pi-blackhole against the winners above. Reserve pi-lcm for tasks that repeatedly revisit many earlier phases or require cross-session archaeology. Its extra hierarchy is harder to justify when a small working-state ledger and keyword recall already suffice.

Use isolated profiles/sessions or equivalent clean test environments. Do not change model, prompt, tool availability and compactor simultaneously. Multiple recall tools can also expand the tool prompt and confuse selection. **One component should own the full compaction decision and apply path.**

## Initial tuning hypotheses—not universal defaults

Retain the native 20k recent-token target in the control, and test a modest larger tail only on tasks where post-compaction local reasoning is damaged. Test earlier compaction at settled task boundaries rather than forcing it after a fixed number of chat messages. Budget separately for protected state, summary, recent tail, expected tool output and model output.

A candidate prompt should explicitly preserve active constraints, unresolved questions, decision rationale, rejected alternatives, exact artifact references and next steps. It should distinguish observed results from plans and assumptions, and never infer resolution from a topic change. These instructions complement extraction and validation; they do not replace them.

## Operational guardrails

Pin versions after a successful canary, log attempted/applied/failed compactions, track live-tail boundaries, and retain a rollback path to native Pi. Before switching back from a custom compactor, verify state migration: native file-detail accumulation in the inspected code does not automatically import every extension-owned checkpoint schema. [2]

# 10. Evaluate continuation, not summary aesthetics

A useful first screen is 10–20 representative tasks across debugging, refactoring, feature work, migration and long tool-heavy investigations, followed by broader evaluation. That is a smoke-test cohort, not enough to prove small differences. Use the same starting repository snapshot, model and tool budget for every arm, with repeated runs for stochastic variation.

## Two complementary experiments

**Matched-budget continuation:** restore the same conversation and workspace at a chosen checkpoint, apply each method under comparable post-compaction budgets, then let the agent finish. This isolates retention quality. **Natural-policy end-to-end:** let each method choose its own trigger/retention policy; include all preceding work, failed summaries, retrieval and cache effects in total task cost.

Force several compaction cycles during stress tests—at least five, with a ten-cycle challenge for the strongest candidates. Put facts and constraints early, mid-session and just before cuts. Also run an unmodified, natural-trigger cohort: forcing frequent cuts can unfairly penalize a method designed for fewer transitions.

| Measure | What to record |
| --- | --- |
| Task completion | Acceptance tests and human-reviewed correctness; not the compactor’s own score. |
| Constraint integrity | Exact active constraints retained, action-level violations, and correct expiration/override handling. |
| State accuracy | Open-loop retention, false “done”/“passed” claims, repeated rejected approaches, current artifact accuracy. |
| Recovery | Successful source retrieval, unnecessary rereads, recovery tokens/turns after each cut. |
| Economics and reliability | Total API cost, cached/uncached input, output, worker calls, wall time, pauses, overflow and apply failures. |

## Failure cases that should be explicit tests

Include a huge single user turn; parallel tool results; a crucial diagnostic beyond 2,000 characters; a later edit invalidating an earlier passing test; a shell-side file change; a reverted decision on a sibling branch; a summarizer timeout; resume after restart; and a switch of model/context window. For asynchronous or observational methods, also test branch changes while memory work is in flight.

## Cost function and selection rule

```
total model cost = sum(billed cost of every model call)
# Includes driver, summaries, memory, retrieval and rework.
# Cache hits/misses belong within each call, not added again.
```

Select the lowest-cost configuration that meets explicit completion and integrity requirements. A proposed promotion gate is no newly observed critical constraint violation, no protocol/branch corruption, and no material completion regression within the chosen tolerance. Report paired differences and uncertainty; zero failures in a small sample does not establish zero risk.

**Final recommendation:** keep native Pi as the control; trial pi-smart-compact for retention and pi-condense-style pruning for economy. Treat pi-vcc’s full replacement as an alternative to measure, not the presumed winner. The durable investment is a scoped, evidence-backed working-state layer that survives changes in model, summarizer and context window.

# Appendix. Scoring detail and source scope

These component scores expose the assumptions behind the ranking. They are not experimental measurements. “Recoverability” credits a reliable route to source evidence, while “critical-state fidelity” penalizes having to recall an obligation that should never leave active state.

| Method | Continue | State | Repeat / recover | Economy | Weighted |
| --- | --- | --- | --- | --- | --- |
| Protected hybrid | 9 | 10 | 9 | 7 | 9.0 |
| Verified structured compaction | 9 | 9 | 9 | 6 | 8.5 |
| Masking + periodic summary | 8 | 8 | 8 | 10 | 8.5 |
| Hierarchical summaries + recall | 8 | 8 | 9 | 6 | 8.0 |
| Observational memory + brief | 8 | 8 | 8 | 8 | 8.0 |
| Provider-native compaction | 8 | 7 | 8 | 9 | 8.0 |
| Native Pi structured compaction | 8 | 8 | 6 | 7 | 7.5 |
| pi-vcc deterministic + recall | 7 | 6 | 7 | 10 | 7.0 |
| FIFO / recent window | 4 | 3 | 3 | 10 | 4.5 |

Read the ranking as a priority order for experimentation. The protected hybrid is a design target; verified compaction and masking are the two highest-priority implementation families to compare. Operational maturity, provider compatibility and integration complexity should be checked separately, not hidden in a claimed task-success percentage.

## Coverage and exclusions

Coverage includes native Pi, pi-vcc, pi-smart-compact, pi-blackhole, pi-lcm, pi-condense/pi-context-prune, asynchronous compaction, Claude Code, Anthropic API context management, Codex/OpenAI native compaction, OpenCode/DCP, Factory and the Volt/LCM architecture.

Learned token/line pruning, reinforcement-learned compaction policies and recursive language-model execution are promising adjacent research directions, but are not required for the first Pi experiment. They generally introduce extra serving/training or orchestration changes that make attribution harder. They are not ranked as ready replacements here.

## Limits of the assessment

Repository READMEs were treated as implementation claims, not independent performance evidence. Relevant source was inspected for Pi’s core prompts/cut settings and pi-vcc’s integration path, but this was not a complete security audit of each repository. Default-branch documents can differ from installed releases. No current model-specific price recommendation is implied by historical dollar-cost benchmarks.

Published experiments address different endpoints: software issue resolution, probe-answer quality, constraint retention, extracted-fact recall and long-context aggregation. Their scores cannot be normalized into one honest empirical leaderboard. A cross-method trial on the actual workload remains the decisive step.

## Safety and data boundaries

Treat recalled tool output as evidence, not as a higher-priority instruction. Keep memory scoped by project, session and branch; protect secrets in archives, debug logs and retrieval. Explicitly approve summarizer/worker fallback providers before sending proprietary code. Any consequential permission boundary must be enforced by the runtime rather than depending solely on remembered prose.

# Sources

1. Pi contributors. [Compaction & Branch Summarization](https://pi.dev/docs/latest/compaction). Latest documentation; accessed September 10, 2026.

2. Pi contributors. [compaction.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts). Default-branch source, including initial/update prompts; accessed September 10, 2026.

3. Pi contributors. [Extensions](https://pi.dev/docs/latest/extensions). Latest lifecycle and context-hook documentation; accessed September 10, 2026.

4. sting8k. [pi-vcc README](https://github.com/sting8k/pi-vcc/blob/master/README.md). Master-branch documentation; accessed September 10, 2026.

5. sting8k. [pi-vcc before-compact.ts](https://github.com/sting8k/pi-vcc/blob/master/src/hooks/before-compact.ts). Master-branch hook implementation; accessed September 10, 2026.

6. sting8k. [Compaction Benchmarks](https://github.com/sting8k/pi-vcc/blob/master/benchmarks/README.md). Ranked compiler versus pi-vcc 0.3.18 baseline; accessed September 10, 2026.

7. alpertarhan. [pi-smart-compact README](https://github.com/alpertarhan/pi-smart-compact/blob/main/README.md). Main-branch EESV, continuity and recall documentation; accessed September 10, 2026.

8. alpertarhan. [Provider Evaluation Baseline](https://github.com/alpertarhan/pi-smart-compact/blob/main/docs/provider-evaluation-2026-08-06.md). August 6, 2026; advisory, three short scenarios per model.

9. k0valik. [pi-blackhole README](https://github.com/k0valik/pi-blackhole/blob/main/README.md). README identifies latest release 0.5.2; accessed September 10, 2026.

10. codexstar69. [pi-lcm README](https://github.com/codexstar69/pi-lcm/blob/main/README.md). Main-branch implementation documentation; accessed September 10, 2026.

11. Pi package catalog / jjuraszek. [pi-condense](https://pi.dev/packages/pi-condense). Catalog version 2.10.3, published September 7, 2026; accessed September 10, 2026.

12. Pi package catalog / championswimmer. [pi-context-prune](https://pi.dev/packages/pi-context-prune). Package documentation; accessed September 10, 2026.

13. Pi package catalog / almogdepaz. [pi-async-compaction](https://pi.dev/packages/pi-async-compaction). Package documentation; accessed September 10, 2026.

14. JetBrains Research. [The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management](https://arxiv.org/html/2508.21433v2). arXiv:2508.21433v2, Tables 1 and 4; accessed September 10, 2026.

15. Factory. [Evaluating Context Compression for AI Agents](https://factory.ai/news/evaluating-compression). December 16, 2025; vendor evaluation.

16. Zhiqi Wang, Yichi Zhang, Dongwon Lee and Yuchen Yang. [Lost in Compaction: Evaluating Side-Constraint Loss under Context Compaction](https://arxiv.org/html/2608.11242v1). arXiv:2608.11242v1, 2026; especially Table 2 and extractor evaluation.

17. Clint Ehrlich and Theodore Blackman. [LCM: Lossless Context Management](https://arxiv.org/html/2605.04050v1). arXiv:2605.04050v1, 2026; architecture and OOLONG evaluation.

18. OpenAI. [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/). Official engineering article; accessed September 10, 2026.

19. OpenAI. [Compaction](https://developers.openai.com/api/docs/guides/compaction). Responses API documentation; accessed September 10, 2026.

20. Anthropic. [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works). Current Claude Code documentation; accessed September 10, 2026.

21. Anthropic. [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction). Current server-side compaction documentation; accessed September 10, 2026.

22. Anthropic. [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing). Current selective tool-result/context editing documentation; accessed September 10, 2026.

23. Anthropic. [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents). Official engineering article; accessed September 10, 2026.

24. OpenCode. [Compaction](https://opencode.ai/v2/docs/compaction). Documented V2 architecture, not an assertion about every installed version; accessed September 10, 2026.

25. Opencode-DCP contributors. [Dynamic Context Pruning Plugin README](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/blob/master/README.md). Master-branch implementation and project-status documentation; accessed September 10, 2026.

26. sting8k. [pi-vcc package.json](https://github.com/sting8k/pi-vcc/blob/master/package.json). Master-branch metadata declares 0.7.2; accessed September 10, 2026.
