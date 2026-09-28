# Chunked memory-processing evaluation — September 2026

## Quality gate

Three serial paired runs of `memory-processing-chunked-triage` passed both arms
after adding an explicit direct-user candidate reconciliation check.
The versioned fixture has two source sessions (182 and 2 entries); the first
exceeds Jev's request window at approximately 77 KiB. It includes an old
release rule later explicitly forgotten, its replacement, an undocumented
provider incident, 180 routine tool results, and a stale prior wiki page.
The verifier checked that the worker published the later rule with its source,
retained and cited the incident, removed superseded and stale claims, and
did not retain routine output. The enabled arm triaged 4 candidates and
180 noise entries across 8 Jev requests. Both arms passed every check.

Earlier enabled trials **missed the incident** despite all four user entries
being candidate judgments; one of those misses occurred even with medium
thinking. The worker now uses medium thinking for both arms and explicitly
checks every direct-user candidate before finishing. The new diagnostic
confirmed that the worker read the incident source even in runs where it
omitted the incident from the wiki. Earlier runs also exposed an eval fixture
error (tool results
without `toolName` were omitted by the real materializer) and a false-negative
verifier that demanded exact wording rather than preserving the incident
meaning and citation. The final paired run used the corrected fixture and
verifier. Three passing paired trials on one fixture are useful regression
evidence, not a broad reliability guarantee.

## Usage and latency

Both arms used the same authenticated `openai-codex/gpt-6-luna` worker, medium
thinking, source image, source sessions and prior wiki in isolated project
stores. The disabled arm had no classifier credentials. The enabled arm used
TypeSafe Jev; its usage was recorded in the run manifest separately from the
worker. Numbers below come from the three paired verifier outputs with the
same source image. Input/output and cache tokens are included in worker totals.

| Trial | Full-audit worker tokens / USD / elapsed | Triage worker tokens / USD / elapsed | Jev input + output tokens |
| --- | --- | --- | ---: |
| 1 | 111,448 / $0.00408688 / 49.79 s | 247,130 / $0.00574836 / 128.40 s | 86,997 + 6,984 |
| 2 | 252,685 / $0.00579538 / 133.47 s | 293,500 / $0.00647784 / 46.72 s | 86,997 + 6,984 |
| 3 | 277,555 / $0.00844582 / 81.01 s | 295,870 / $0.00656460 / 49.00 s | 86,997 + 6,984 |

Each enabled run made 8 Jev requests (about 2.8–3.5 s of recorded evaluation
time). Across three trials, the full audit used 641,688 worker tokens,
$0.01832808 worker cost, and 264.27 s; triage used 836,500 worker tokens,
$0.01879080 worker cost, and 224.12 s **plus** 281,943 Jev tokens (total
measured 1,118,443). The Jev response did not include USD cost, so enabled
total cost is **unknown**, not $0.01879080. Triage used 476,755 more measured
tokens, and worker-only cost was already higher. Latency varied substantially
across trials. **Do not claim savings or generalize quality from one fixture.**

## Reproduce

Current source commit: `8a0a2dfc923cad2bcaaaa35672e69e578133fb5c`
(dirty checkout); packed source image:
`felan-evals-source:fce07286db9419c0751ec6ac`, source digest
`fce07286db9419c0751ec6acf67c9a04073a5551143bd83e4429809f5c8ed69a`.
The case and fixture are under `evals/cases/memory/processing/` and
`evals/fixtures/memory-processing/v1/`. The harness records the exact image,
model, config, workspace and verifier artifacts in ignored `.harness-evals/`.

```sh
pnpm eval:build-source
pnpm eval:run --case memory-processing-chunked-triage --concurrency 1
```

Provider-backed runs require explicit authorization, Docker, an authenticated
OpenAI Codex profile for the pinned worker model, and `TYPESAFE_API_KEY` for
the enabled arm. The test mounts OAuth into an isolated container and copies
it only into that container's ephemeral `/tmp` storage for the memory worker;
neither credential nor private transcript is part of the versioned fixture or
results. Grade quality before comparing total cost, tokens and latency; absent
provider usage remains unknown.
