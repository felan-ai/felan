# @felan-ai/ext-session-compaction

Portable, bounded verified session compaction and active-lineage recall for
Felan hosts.

When enabled, the extension attempts one summary through Pi's
`session_before_compact` hook. By default it inherits the active session model.
Evidence is priority-packed within bounded lanes. A split-turn lane preserves
the actual user input, assistant text and reasoning, and normalized tool
outcomes in chronological order. Successful file reads retain their path rather
than file contents; writes and patches retain affected paths and status rather
than payloads; commands retain bounded output; and failure text remains high
priority. Protected continuity and current decisions/state take precedence over
repetitive successful tool output.
The `sessionCompaction.model` setting may instead select `xhigh`, `high`,
`medium`, or `low`; tiers use the host's allowed models and prefer the active
provider/family. An unavailable tier falls back to inherit. Pi remains the owner of compaction preparation,
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
omitted to fit its bounded lane. If the narrative or model-aware prompt budget
cannot fit safely, the extension returns no custom result before making a model
request and native Pi compaction takes over. Generated summaries must contain
the canonical checkpoint headings and split-turn headings when applicable;
unsupported completion or verification claims are rejected. These safeguards
improve recoverability but do not prove semantic completeness.

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
    "sessionCompaction": { "model": "inherit" }
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
