# Inspect/noise memory-processing evaluation — September 2026

## Quality first

Three serial paired provider-backed runs of `memory-processing-chunked-triage`
passed all verifier checks in both arms. The fixture contains two sessions with
184 redacted evidence records, including a long noisy session, a later forget
and replacement rule, an undocumented provider incident, and stale prior wiki
content. The verifier checks publication, both corrected release rules and
source citations, the incident and its source, removal of stale claims, and
absence of routine output in the wiki. Every enabled run split 4 records into
`inspect` and 180 into `noise`, with no uncertain classifications; a fixture
check confirmed each original JSONL record was present exactly once, unchanged,
in one of the two staged sources. The worker read every direct-user source.

This is three passes on **one** verified fixture, not a general reliability
guarantee. The fixture did not require the worker to grep noise; isolated TUI
tests exercise actual scoped grep on noise, the staged wiki, and the default
staged search scope. Historical results for the earlier decision-map design
remain in `../2026-09-memory-processing-chunked/README.md` and are not directly
comparable: that image ran different worker instructions and staging.

## Tokens, cost, latency

Each arm used the same authenticated `openai-codex/gpt-6-luna` worker with
medium thinking, the same source image, sessions, and prior wiki in isolated
stores. The enabled arm additionally called TypeSafe Jev 8 times per run;
Jev's response reported tokens but **not USD cost**. Worker tokens include
cache reads and writes.

| Trial | Full-audit worker tokens / USD / elapsed | Split worker tokens / USD / elapsed | Jev input + output tokens |
| --- | --- | --- | ---: |
| 1 | 189,908 / $0.00494312 / 42.24 s | 81,840 / $0.00328408 / 53.90 s | 82,213 + 5,696 |
| 2 | 175,574 / $0.00477924 / 46.75 s | 147,543 / $0.00424950 / 62.30 s | 82,213 + 5,696 |
| 3 | 234,670 / $0.00571764 / 60.50 s | 102,907 / $0.00358134 / 52.17 s | 82,213 + 5,696 |

Across three pairs, full audit used **600,152 worker tokens**, **$0.01544000
worker cost**, and **149.49 s**. The split arm used **332,290 worker tokens**
plus **263,727 Jev tokens** = **596,017 combined measured tokens**, **$0.01111492
worker cost plus unknown Jev cost**, and **168.37 s**. The combined measured
token difference is **4,135 fewer** (0.69%), but enabled latency was **18.89 s
longer**, and no net USD savings can be established. Token reduction and
worker-only cost are **not** a savings claim.

## Reproduce

The current-source image was `felan-evals-source:b3940e822342e09912cfe0dd`
(digest `b3940e822342e09912cfe0dd826d676881bf5a61469f7ec8581ebc98ed474dd2`),
from dirty commit `8a0a2dfc923cad2bcaaaa35672e69e578133fb5c` with packed
`@felan-ai/ext-memory@0.6.0` and `@felan-ai/felan@0.26.17`. The case,
fixture and verifier are in `evals/cases/memory/processing/` and
`evals/fixtures/memory-processing/v1/`. Run artifacts, including per-arm
verifier output and usage, reside in ignored `evals/.harness-evals/runs/` with
timestamps `2026-09-28T10-58`, `10-59`–`11-00`, and `11-01`–`11-03`.

```sh
pnpm eval:build-source
pnpm eval:run --case memory-processing-chunked-triage --concurrency 1
```

Provider-backed runs require explicit authorization, Docker, an authenticated
OpenAI Codex worker profile, and `TYPESAFE_API_KEY`. The fixture is synthetic;
the isolated eval stores are not canonical project memory. Evaluate factual
quality and citations before comparing costs, and treat missing Jev USD cost
as unknown rather than zero.
