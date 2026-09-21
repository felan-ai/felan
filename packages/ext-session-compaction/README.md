# @felan-ai/ext-session-compaction

Portable, bounded verified session compaction and active-lineage recall for
Felan hosts.

When enabled, the extension uses classifier compaction by default through Pi's
`session_before_compact` hook when the runtime exposes a classifier. Without
that optional capability it uses the verified summary method, which inherits
the active session model by default. Evidence is priority-packed within bounded
lanes. A split-turn lane preserves the actual user input, assistant text and
reasoning, and normalized tool outcomes in chronological order. Successful file
reads retain their path rather than file contents; writes and patches retain
affected paths and status rather than payloads; commands retain bounded output;
and failure text remains high priority. Protected continuity and current
decisions/state take precedence over repetitive successful tool output.
The `sessionCompaction.model` setting may instead select `xhigh`, `high`,
`medium`, or `low`; tiers use the host's allowed models and prefer the active
provider/family. An unavailable tier falls back to inherit.
`sessionCompaction.method` defaults to `classifier`, which selectively retains
the prepared transcript when the optional runtime classifier is available and
otherwise uses the verified summary method. Set it to `summary` to disable
classification explicitly. Classifier compaction does not make a summary-model
request, but it does send bounded compaction evidence to the host-injected
classifier's provider. All eligible bulky
`observation`, `command`, and `test` results admitted by the central evidence
bounds are classified (keep exact contents, keep outcome only, or drop as
obsolete). Agent Core may partition the questions across provider requests.
Commands and tests may be shortened but not dropped. Classifier failure returns
control to native Pi. Classifier traces go to `pi.runtime.logger`; they are not
written to session JSONL.
Pi remains the owner of compaction preparation,
cut points, retained tails, session trees, overflow recovery, and persistence.
If the extension is absent or a recoverable generation/validation failure occurs
before acceptance, Pi's native summarizer remains in control. A failure after Pi
accepts a custom result cannot automatically rerun native compaction.
Every recoverable fallback emits a warning that Pi native compaction will take
over and persists one bounded metadata-only `custom` entry with the fallback
reason and sanitized model error details. The entry is not rendered, sent to
the model, or returned by `session_recall`; it records delegation, not native
compaction success. User cancellation is not reported as a fallback.

The split-turn narrative is mandatory, while lower-priority tool records may be
omitted by the central extraction bounds. Summary output uses Pi's prepared
reserve-token budget and the selected model's limits; prompt fit uses the model
context window. Classifier output is not rejected merely for exceeding an
extension-defined byte size. If required evidence or a model request cannot fit
safely, the extension returns no custom result before acceptance and native Pi
compaction takes over. The prompt still asks for canonical checkpoint headings,
but a non-empty summary is accepted even if those headings are missing.
Unsupported completion or verification claims are still rejected. These
safeguards do not prove semantic completeness.

The extension does not add a fixed summary-result, prompt-byte, summary-token,
or wall-clock ceiling. Pi owns compaction reserve/tail preparation, the active
model owns context and output capacity, and the central evidence bounds keep
untrusted extraction and protected continuity finite. Jev transport batching
and its request/response safety envelope belong to Agent Core.

The package also provides bounded `session_recall` over the current
`SessionManager.getBranch()` lineage. It never reads session files directly,
searches sibling branches, or reads RTK recovery artifacts. Transcript and
generated summary text are untrusted historical evidence.

The package is host-neutral and does not provide cross-session memory, a TUI,
provider-specific storage, or ambient extension discovery. The local TUI
enables it by default and disables it with
`builtinExtensions.sessionCompaction: false`.

The local configuration is:

```json
{
  "extensionConfig": {
    "sessionCompaction": { "method": "classifier", "model": "inherit" }
  }
}
```

The equivalent CLI override is
`--session-compaction-model <inherit|xhigh|high|medium|low>`. The setting is
resolved when a new runtime is constructed. A selected-model request still
makes only one attempt; generation or validation failure returns control to
native Pi, which uses the active model. Summary requests set
`cacheRetention: none` and are separate from the main agent request.

## Development

```sh
pnpm --filter @felan-ai/ext-session-compaction build
pnpm --filter @felan-ai/ext-session-compaction type-check
pnpm --filter @felan-ai/ext-session-compaction test
```
