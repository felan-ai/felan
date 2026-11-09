# @felan-ai/ext-insights

Local session analytics for Felan Code. The default entry uses shared
`SESSIONS_HISTORY_SERVICE`, runtime storage, and generic `pi.ui` notifications and an interactive dashboard document. It does not require the legacy Insights service or native UI. Direct integrations can still use `createInsightsExtension(host)` and `InsightsHost` for custom discovery, storage, and report presentation (`presentReport`).

The package does not access the filesystem or ambient Pi directories directly.
The local host must keep session visibility, transcript size, and cache retention
explicit.

Sessions are discovered from the history list alone. The parser cache is keyed
by session ID, root, last update time and parser version, so an unchanged session
loads without any history read. A changed session is read through history: the
first page pins the journal revision and branch for the remaining pages, the
parser consumes the returned entries without converting them back to JSON text,
and a session written during the read restarts from a fresh first page. The
history service enforces the 64 MiB transcript limit. Sessions load concurrently, bounded by
the host's available parallelism, while a status line reports progress. After a
complete scan, cache entries that no listed session references are removed.
Invalid pagination fails the scan. A session that is inaccessible, unsupported,
oversized, empty, unparseable or still changing after three stale reads is
skipped, and the command reports how many sessions were skipped and why instead
of turning them into empty sessions. If the history service reports
`unavailable` because the calling session is cancelling or closing, the scan
stops, no report is written and the command warns once. Forked and cloned sessions copy their
parent's entries, so each copied entry is counted once, on the earliest session
that contains it. Default report
commands are serialized; cancellation and shutdown join pending reads, writes,
and UI operations before closing report handles. Dashboard actions are revision-checked. Range, search and session paging recompute from the transcripts loaded by the command, so they do not rescan history. Browser opening runs only after a local-console confirmation and uses literal argv on the host.

The stored HTML report is a self-contained static snapshot. Every
`/insights` invocation rescans visible root and retained subagent transcripts,
reparses new or changed files, and replaces the report. Unchanged files reuse
parser-versioned metadata. Opening the generated HTML later does not reread live
files. `--refresh` is only a force-reparse option for unchanged files.

The terminal dashboard has Overview, Models, Projects, Sessions and Rage tabs. Its ranges are `7d`, `30d`, `90d`, `all` and the `--since` value. Projects can be sorted, the daily series can switch between sessions, tokens and cost, and sessions can be searched and paged. `o` asks the local console to confirm, then opens the HTML snapshot in the host's default application. Clients without the hint receive the same actions in a Markdown fallback.

The HTML report includes the Felan Code-branded activity calendar, daily/hourly/model/project/rage charts, model-efficiency metrics, date presets and custom ranges, session search, sortable project breakdowns, and light/dark theme switching. When the local host has Savings measurements, the report also
includes filterable avoided-cost, producer, category, project, daily, and
measurement-detail breakdowns. Savings are estimated API-equivalent cost
avoided, not an invoice or guaranteed billing reduction; unpriced measurements
are shown as incomplete. The default Felan Code host does not supply savings to
this report; it shows them in the `/savings` dashboard.

Time ranges include activity whose event timestamp is at the start boundary
and exclude activity at the end boundary. A resumed root session is included
when it has activity in the range, and retained subagent turns are grouped into
that root session. Costs are estimated from assistant-message usage data, not
provider invoices. Rage hits and thinking-level changes are kept per message, so
every range includes them. Tool errors come from tool-result messages and count
against the model that made the call. Model counts are assistant messages, and
daily session counts count each session once per active day.

## Development

```sh
pnpm --filter @felan-ai/ext-insights build
pnpm --filter @felan-ai/ext-insights type-check
pnpm --filter @felan-ai/ext-insights test
```

## Attribution

This package adapts the MIT-licensed `pi-insights` implementation. See
[NOTICE](NOTICE) and [LICENSE](LICENSE).
