# Cached-prefix versus fresh summary compaction

Measured on 2026-10-23. This small sample establishes no quality difference.
Cached-prefix summarization cost ~1.8x more per compaction than Felan's fresh
verified summary and was removed. Idle expiry compaction was not benchmarked.

## Method

Harness batch `20261023-075412-1860` ran benchmark `session-cached-compaction`
revision 1 using source image `felan-evals-source:49f622d8ee8d767d138ca59d`, built
from Felan commit `41e4e7f` plus an uncommitted working tree. The case and arms
were removed with the feature; this document preserves the measured record.

Case `session-compaction-cached-continuation` resumed the real 217,549-token
fixture session `01a042ca-0d42-75eb-aeac-0397822915e2` from
`fixtures/session-compaction/v1` with `--session-dir`. The agent ran a tiny
warm-up bash command, then two 50,000-byte synthetic pressure commands in
separate turns (Pi's bash output cap is 50 KB), crossing the 222,000-token
threshold (272,000 window - reserveTokens 50,000; keepRecentTokens 20,000).
One threshold compaction ran before the final tool-free answer to:

> Can you review the changes for overcomplication and over-engineering? Explain
> how they were tested end to end; if a true black-box end-to-end test was not
> run, outline exactly how to run one.

The arms were identical except for `cachedSummary`: `openai-codex` /
`gpt-5.6-sol`, thinking `low`, method `summary`, `compactBeforeCacheExpiry: false`,
and Codex `postAgentRunCompaction: false`. The baseline used a fresh verified
summary; the candidate used a cached-prefix summary. Each arm ran 3 trials,
serially. A deterministic verifier scored summary fidelity and continuation
fidelity against required facts; the quality gate required a pass rate >= 0.8.

Costs are Pi API-equivalent USD estimates. Codex OAuth bills subscription quota,
not these estimated dollar amounts.

## Results

| Arm | Trial | Verifier | Summary fidelity | Continuation fidelity | Compaction usage (input / cacheRead / output) | Compaction cost | Run cost | Run prompt tokens | Duration |
|---|---|---|---|---|---|---|---|---|---|
| fresh | 1 | pass | 0.889 | 0.9 | 10,777 / 0 / 1,052 | $0.0641 | $1.1510* | 649,829 | 50 s |
| fresh | 2 | fail (continuation missed required `black-box-e2e-plan`) | 0 | 0 | 10,774 / 0 / 1,067 | $0.0644 | $0.3821 | 649,841 | 50 s |
| fresh | 3 | pass | 0.889 | 0.9 | 10,773 / 0 / 1,291 | $0.0689 | $0.3936 | 650,064 | 66 s |
| cached | 1 | pass | 0.778 | 0.9 | 6,768 / 213,504 / 1,205 | $0.1366 | $0.4555 | 859,477 | 55 s |
| cached | 2 | pass | 0.778 | 0.9 | 112 / 220,160 / 1,206 | $0.1126 | $0.4221 | 859,478 | 55 s |
| cached | 3 | pass | 0.889 | 0.9 | 112 / 220,160 / 1,369 | $0.1159 | $0.4268 | 859,588 | 66 s |

*Fresh trial 1 started with a cold main-conversation cache (235,493 uncached
input tokens); the other five reused the provider cache shared across trials
through the fixture's session id. Excluding it, fresh runs cost $0.38-0.39 and
cached runs $0.42-0.46.

- **Quality:** cached 3/3, fresh 2/3. The fresh failure was in the final answer:
  its compaction summary mentioned end-to-end testing 11 times, but the answer
  omitted the required black-box plan. With n=3 this is not evidence of a quality
  difference; summary fidelity was equal or lower for cached (0.778-0.889 vs 0.889).
- **Cost and tokens:** each cached summary re-reads the whole ~220k-token prefix
  at the cached rate, ~$0.11-0.14 per compaction vs ~$0.064-0.069 for Felan's
  bounded ~10.8k-token fresh prompt (~1.8x). Cached-prefix reuse only wins when
  10% of the session prefix is smaller than the bounded fresh prompt (roughly
  sessions under ~100k tokens), where threshold compaction rarely runs.
- **Latency:** no meaningful difference (50-66 s per run for both arms).

## Limits and decision

Limits: one case, one model/provider, n=3 per arm, dirty source tree. Harness
status shows FAIL for all six because a workspace-diff assertion did not expect
the daemon's `sessions/.felan-store.lock`; that assertion does not affect
verifier quality scores. The shared provider cache and cold first trial limit
whole-run cost comparisons. Token reduction alone is not a savings claim.

Drop cached-prefix summarization and use Felan's fresh verified summary as the
default method. Keep the fast classifier method as an opt-in, not a measured
cost saving. [Idle compaction before prompt-cache expiry](../decisions/0045-compact-before-prompt-cache-expiry.md)
may use the configured classifier or fresh verified summary, but its cost
benefit has not been benchmarked.
