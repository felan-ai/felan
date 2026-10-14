# @felan-ai/ext-insights

Local session analytics for Felan Code. The default entry uses shared
`SESSIONS_HISTORY_SERVICE`, runtime storage, and generic `pi.ui` notifications and paged
report documents. It does not require the legacy Insights service or native UI.
Direct integrations can still use `createInsightsExtension(host)` and
`InsightsHost` for custom discovery, storage, and report opening.

The package does not access the filesystem or ambient Pi directories directly.
The local host must keep session visibility, transcript size, and cache retention
explicit.

Shared-history reads pin the complete journal revision and branch, use the exact
checkpoint byte length, and enforce the 64 MiB limit while collecting entries.
Cache identity includes the whole-journal revision, not only the active-branch
digest. Duplicate entries, invalid pagination, inaccessible histories, and stale
revisions fail rather than silently becoming empty sessions. Default report
commands are serialized; cancellation and shutdown join pending reads, writes,
and UI operations before closing report handles. Generic report navigation uses
revision-checked actions and UTF-8-bounded pages without splitting Unicode code
points or discarding report text.

The stored HTML report is a self-contained snapshot dashboard. Every
`/insights` invocation rescans visible root and retained subagent transcripts,
reparses new or changed files, and replaces the report. Unchanged files reuse
parser-versioned metadata. Opening the generated HTML later does not reread live
files. `--refresh` is only a force-reparse option for unchanged files.

It includes the Felan Code-branded activity calendar,
daily/hourly/model/project/rage charts, model-efficiency metrics, date presets
and custom ranges, session search, sortable project breakdowns, and light/dark
theme switching. When the local host has Savings measurements, the report also
includes filterable avoided-cost, producer, category, project, daily, and
measurement-detail breakdowns. Savings are estimated API-equivalent cost
avoided, not an invoice or guaranteed billing reduction; unpriced measurements
are shown as incomplete.

Time ranges include activity whose event timestamp is at the start boundary
and exclude activity at the end boundary. A resumed root session is included
when it has activity in the range, and retained subagent turns are grouped into
that root session. Costs are estimated from assistant-message usage data, not
provider invoices.

## Development

```sh
pnpm --filter @felan-ai/ext-insights build
pnpm --filter @felan-ai/ext-insights type-check
pnpm --filter @felan-ai/ext-insights test
```

## Attribution

This package adapts the MIT-licensed `pi-insights` implementation. See
[NOTICE](NOTICE) and [LICENSE](LICENSE).
