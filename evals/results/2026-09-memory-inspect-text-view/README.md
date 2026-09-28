# Memory inspect text view — offline format comparison

## Quality

`pnpm --filter @felan-ai/felan test -- test/memory-comparison.test.ts` runs
three isolated coordinator paths over the same release-decision and incident
sessions and the same stale prior wiki: full JSONL audit, classified inspect
JSONL, and classified readable inspect view. A scripted worker derives output
from the selected source. All three publish the same wiki, including the later
decision, the incident with its source ID, and removal of stale prior claims.
Portable tests also require mixed text/tool-call records to stay in original
JSONL rather than silently losing their tool call in a text view. This proves
rendering and scripted coverage, **not** that a live worker will use the view
correctly on every session.

## Size, cost, and latency

`node evals/scripts/compare-memory-view.mjs` deterministically materializes
the synthetic `memory-processing/v1` sessions, selects the same four direct-user
inspect entries as the earlier triage fixture, and renders the view with the
shared parser. It reports **723 UTF-8 bytes** for inspect JSONL versus **681
bytes** for the readable view: **42 fewer bytes** on this fixture. The original
JSONL and deferred noise still remain available; these numbers measure only
the primary four-entry inspect source, not staging storage or a full model
prompt. There is no provider tokenization, cache, USD cost, latency or live
output quality measurement for the view. Byte differences are not a token or
cost savings claim.

The previous paired provider results in
`../2026-09-memory-processing-inspect-noise/README.md` used a source image
that predates the readable view and must not be attributed to it. Any
provider-backed comparison requires fresh explicit authorization, identical
sources/model settings, correctness and citations first, then combined
classifier-plus-worker tokens, USD cost and elapsed time.
