# @felan-ai/ext-session-compaction

Portable, bounded verified session compaction and active-lineage recall for
Felan hosts.

When enabled, the extension uses the verified summary method by default through
Pi's `session_before_compact` hook. It inherits the active session model unless a
summary-model tier is configured. Evidence is priority-packed within bounded
lanes. A split-turn lane preserves the actual user input, assistant text and
reasoning, and normalized tool outcomes in chronological order. Successful file
reads retain their path rather than file contents; writes and patches retain
affected paths and status rather than payloads; commands retain bounded output;
and failure text remains high priority. Protected continuity and current
decisions/state take precedence over repetitive successful tool output.
The `sessionCompaction.model` setting may instead select `xhigh`, `high`,
`medium`, or `low`; tiers use the host's allowed models and prefer the active
provider/family. An unavailable tier falls back to inherit.
`sessionCompaction.method` defaults to `summary`. Set it to `classifier` to opt
into fast selective retention of the prepared transcript when the optional
runtime classifier is available; otherwise it uses the verified summary method.
Successful classifier compaction does not make a summary-model request, but it
does send bounded compaction evidence to the
host-injected classifier's provider. All eligible bulky
`observation`, `command`, and `test` results admitted by the central evidence
bounds are classified (keep exact contents, keep outcome only, or drop as
obsolete). Agent Core may partition the questions across provider requests.
Commands and tests may be shortened but not dropped. Classifier failure enters
the verified summary request below using the configured `sessionCompaction.model`.
For ordinary compaction, native Pi takes over if that chain fails or classifier
split-prefix preparation fails; the latter shares rendering and bounds with the
summary prompt. Classifier traces go to
`pi.runtime.logger`; they are not written to session JSONL.
Pi remains the owner of compaction preparation,
cut points, retained tails, session trees, overflow recovery, and persistence.
For ordinary compaction, if the extension is absent or a recoverable
generation/validation failure occurs before acceptance, Pi's native summarizer
remains in control. Cache-expiry compaction instead cancels if the configured
method and its verified summary fallback fail. A failure after Pi accepts a
custom result cannot automatically rerun native compaction.
Every native fallback emits a warning that Pi native compaction will take
over and persists one bounded metadata-only `custom` entry with the fallback
reason and sanitized model error details. The entry is not rendered, sent to
the model, or returned by `session_recall`; it records delegation, not native
compaction success. User cancellation is not reported as a fallback.

The local TUI identifies completed compactions as `Classifier`, `Summary`, or
`Native` in the collapsed transcript row. Felan fallback warnings stay concise;
the persisted metadata-only diagnostic retains the bounded reason and error
details for troubleshooting.

The split-turn narrative is mandatory, while lower-priority tool records may be
omitted by the central extraction bounds. Compaction reads Pi's prepared
messages through Agent Core's shared lossless text-block reader, then
applies its own status extraction, evidence ranking, deduplication and
bounded selection. Its compacted evidence is not a lossless transcript and
must not replace the original source used for cross-session memory. Summary
output uses Pi's prepared reserve-token budget and the selected model's limits;
prompt fit uses the model
context window. Classifier output is not rejected merely for exceeding an
extension-defined byte size. For ordinary compaction, if required evidence or a
model request cannot fit safely, the extension returns no custom result before
acceptance and native Pi compaction takes over. The prompt still asks for canonical checkpoint headings,
but a non-empty summary is accepted even if those headings are missing.
Unsupported completion or verification claims are still rejected. These
safeguards do not prove semantic completeness.

The extension does not add a fixed summary-result, prompt-byte, summary-token,
or wall-clock ceiling. Pi owns compaction reserve/tail preparation, the active
model owns context and output capacity, and the central evidence bounds keep
untrusted extraction and protected continuity finite. The runtime's unified
`classify` operation and bounded admission/question batching belong to Agent
Core; model selection, credentials and native Pi transport belong to the host.

The package also provides bounded `session_recall` over the current
`SessionManager.getBranch()` lineage. It never reads session files directly,
searches sibling branches, or reads RTK recovery artifacts. Transcript and
generated summary text are untrusted historical evidence.

The package is host-neutral and does not provide cross-session memory, a TUI,
provider-specific storage, or ambient extension discovery. Configured hosts
enable it through their extension list; execution does not require a client
renderer or feature service.

The local configuration is:

```json
{
  "extensionConfig": {
    "sessionCompaction": {
      "method": "summary",
      "model": "inherit",
      "compactBeforeCacheExpiry": true,
      "minContextTokens": 200000
    }
  }
}
```

The equivalent CLI override is
`--session-compaction-model <inherit|xhigh|high|medium|low>`. The setting is
resolved when a new runtime is constructed.

## Summary requests

The summary method, including fallback after classifier failure, makes one
fresh verified request using a separate summary prompt and `cacheRetention: none`.
It uses the same provider idle timeout as agent requests. If the request or its
validation fails before acceptance, ordinary compaction falls back to native Pi.
Cancellation stops the chain. Expiry-triggered compaction cancels on failure
instead of invoking native Pi.

Accepted summary and classifier results append Pi-format `<read-files>` and
`<modified-files>` sections and store the lists in their details. Lists merge the
latest compaction's file details, including previous Felan compactions, with Pi's
prepared file operations; they are sorted, deduplicated, and bounded to 200 paths
per list and 1,024 bytes per path. Modified paths are omitted from the read-only
list.

The logger emits an info-level `session compaction request` record for every
summary request, including failed ones. It records the trigger, model, outcome,
latency, and, when available, input/cache-read/cache-write/output tokens and cost.
`cacheShare` is cache-read tokens divided by total input tokens, rounded to three
decimals; it is omitted for zero total input. Classifier traces remain separate
debug logs. Request logs and fallback diagnostics never enter model context.

## Before cache expiry

`compactBeforeCacheExpiry` defaults to `true`. At agent turn end, and on session
start, tree navigation, or model changes, the extension schedules a countdown to
about 20 seconds before a **known** cache lifetime expires. When it fires, it
rechecks expiry, idle state, queued messages, and context usage. Pi cache-warming
events extend the expiry and cause the countdown to be rescheduled.

Compaction runs only when Pi auto-compaction is not disabled
(`pi.getSettings().compaction.enabled !== false`), the agent is still idle with
nothing queued, and context usage is at least `minContextTokens` (default 200000;
a nonnegative integer). It uses the configured compaction method: classifier
when selected and available, with a fresh verified summary as fallback; otherwise
the fresh verified summary directly. A summary model must resolve unless the
selected classifier is available. Every pre-acceptance failure that exhausts
these paths cancels the attempt without a native fallback diagnostic or warning.
Expiry-triggered attempts **never** invoke native Pi. Accepted results record
`trigger: 'cache-expiry'`, and summary request logs use the same trigger. The user
receives a notification before compaction.

Unknown lifetimes, including `openai-codex` models in Pi's catalog, never trigger
expiry compaction. Set `compactBeforeCacheExpiry: false` to disable idle compaction
without changing ordinary compaction.

## Development

```sh
pnpm --filter @felan-ai/ext-session-compaction build
pnpm --filter @felan-ai/ext-session-compaction type-check
scripts/test-isolated.sh pnpm --filter @felan-ai/ext-session-compaction test
```
