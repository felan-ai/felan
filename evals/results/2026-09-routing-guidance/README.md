# Classifier routing validation — 2026-09-24

The cases, fixture, agent configurations, and verifier assertions are in
`evals/cases/subagents/`, `evals/fixtures/subagent-routing/v1/`, and
`evals/felan-extension-evals.yaml` (`subagents-routing`, revision 5). The
source-image build recorded Git commit `e942a240bcedda4dbeb9bc85710015c977bb2700`
with a dirty working tree. These are local source-image runs, not a published
package comparison.

## Method

Build the current source image with `pnpm eval:build-source`, then run
`pnpm eval:run --benchmark subagents-routing --concurrency 1 --cleanup`.
Both arms use Grok 4.6 at high thinking. The candidate also has a TypeSafe
classifier, but one-shot JSON mode deliberately skips asynchronous discovery
delegation: the process would otherwise exit before the child notice resumes
the parent. The quality assertions check the exact answers and no workspace
edits. The explicit implementation/review case remains a separate diagnostic;
it is not graded by this benchmark because one-shot mode cannot await children.

## Results

An initial run on source image `felan-evals-source:f3e1b00628af21babeda950c`
failed the quality gate. The classifier recommended discovery for the two
read-only investigations (probabilities 0.87 and 0.83) and an explicit
implementation/review request (0.73). Parents launched `explore` agents,
then ended with “I'll wait” before receiving their results. The baseline
passed both read-only investigations; the explicit implementation/review case
also failed in one-shot mode. This exposed a correctness regression, not a
cost saving.

After skipping discovery classification in one-shot sessions, a second run on
source image `felan-evals-source:2d390772b63cb6e301e865a7` completed:

| Arm | Correct cases | Cost (USD) | Prompt tokens | Output tokens | Step duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| Static | 3/3 | 0.070514 | 45,745 | 2,744 | 57,080 ms |
| Classified | 3/3 | 0.058614 | 45,549 | 2,586 | 47,811 ms |

Both arms avoided child agents in this one-shot comparison. The observed
differences do **not** establish savings from classifier-guided delegation;
they reflect model-run variance in an evaluation that did not exercise
delegation. A persistent-session benchmark with verified child completions is
still required before claiming subagent cost or latency savings. The raw local
run artifacts are ignored under `evals/.harness-evals/` and were not copied
here because they can contain session transcripts.
