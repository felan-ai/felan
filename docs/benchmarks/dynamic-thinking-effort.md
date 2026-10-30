# Dynamic-thinking savings estimate

Felan uses a single explicitly heuristic high-effort estimate for every model
that supports dynamic thinking. The provider's output-token price does not
change with effort; an effort label alone does not establish a dollar saving.
The heuristic extrapolates from one public same-model effort comparison, not
from matched benchmarks for every supported model. It must not be presented as
model-specific calibrated or verified task savings.

| Public source | Current qualification |
| --- | --- |
| [Anthropic effort guide](https://platform.claude.com/docs/en/build-with-claude/effort) | Describes token and quality trade-offs, but gives no matched output-token counts. Not a numerical baseline. |
| [UnifyBench effort observations](https://unifybench.ai/data/effort-benchmarks.json) | Provides effort-separated capability scores and source links; matched billable output-token counts have not been established. Not a numerical baseline. |
| [Artificial Analysis GPT-6 Astra benchmark](https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra) ([token chart](https://cdn.sanity.io/images/6vfeftx9/articles/c7f04c509e53444df28a4c1ada6683d1bbff1eb5-4640x4224.png)) | The same Intelligence Index workload reports approximately 12k total output / 7k reasoning tokens at `high` and 10k total output / 6k reasoning tokens at `medium`, with index scores about 51 and 50. This is the numerical anchor for the heuristic, not evidence that the same ratio holds on other models, effort pairs or tasks. `low` scores about 46, showing quality can decline. |
| [Artificial Analysis model comparisons](https://artificialanalysis.ai/models/comparisons) | Other effort-separated pages expose a Token Use heading, but no comparable numerical reasoning-token pairs were verified; Opus 5.5 comparisons explicitly include fallback. No model-specific calibration. |

The Astra observations above were inspected on 2026-09-28. They are weighted
averages over Artificial Analysis's benchmark; the chart does not disclose the
underlying sample count. They are not Felan turns or proof that every
lower-effort response is equally correct. A transport or workload change can
invalidate the estimate. The high/medium chart shows approximately 7k/6k
reasoning tokens (about a 17% increase). The estimator deliberately assumes
only **5%** more reasoning tokens at the user's baseline, rounded down per
response, for automatic selections below a `high`, `xhigh`, or `max` baseline
on any supported model. This is an unvalidated cross-model extrapolation,
including for Claude. It adds those
tokens to the actual billable output total, leaving input, cache,
and visible output unchanged; this avoids overlapping visible-output savings
reported by other producers. Specifically, `extra = floor(actual.reasoning / 20)`
and `baseline.output = actual.output + extra`. The baseline cost is the
observed response cost plus `extra × observed_output_cost / observed_output_tokens`
(the response's effective output rate, including any price tier); the
actual cost additionally includes the classifier's USD cost when supplied.
There is no entry when that net difference is nonpositive. If the classifier
does not expose its cost, this is a gross API-equivalent estimate and excludes
that overhead. Missing reasoning counts, zero uplift, effort at or above the
baseline, failed tool results, and aborted runs generate no entry. Reporting waits
until the run settles successfully; only its first assistant response to an
automatic selection below a high-or-above baseline is counted. The baseline is
the user's level before the first automatic change, not the previous automatic
selection. Subsequent tool continuations and unchanged lower-effort turns are not.
Even a successful response does not establish task equivalence, so these
remain heuristic API-equivalent estimates, not verified savings. No benchmark
establishes equal quality or the 5% ratio across every supported model.

## Extended effort anchor

The same [Artificial Analysis GPT-6 Astra token chart](https://cdn.sanity.io/images/6vfeftx9/articles/c7f04c509e53444df28a4c1ada6683d1bbff1eb5-4640x4224.png),
inspected on 2026-10-30, gives the following approximate bar totals, stacked
segments, and Intelligence Index scores. Totals and segment labels are
approximate and may not add exactly; the unlabelled medium segment is inferred
from its total.

| Effort | Total output tokens | Stacked segments | Intelligence Index |
| --- | --- | --- | --- |
| `medium` | 10k | 6k labelled / ≈4k unlabelled | ≈50 |
| `high` | 12k | 7k / 5k | ≈51 |
| `xhigh` | 17k | 8k / 9k | ≈53 |
| `max` | 27k | 11k / 17k | ≈53 |

Whichever stacked segment is the reasoning segment, `xhigh` and `max` reasoning
exceed `high` by at least approximately 14% and `medium` by at least approximately
33%. Applying the same 5% uplift to `xhigh` and `max` baselines therefore stays
below this public anchor. Method `high-effort-reasoning-5pct-heuristic-v2`
extends eligibility to those baselines without increasing the uplift. The
comparison remains one model's weighted benchmark averages, not validation for
other models (including Claude), every lower effort pair, or equal task quality.
It supports a heuristic API-equivalent estimate, not verified task savings.
