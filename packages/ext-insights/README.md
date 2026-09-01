# @felan-ai/ext-insights

Portable session analytics for Felan. The package owns parsing and analytics;
the host owns session discovery, bounded reads, report storage, and opening a
report through `InsightsHost`.

The package does not access the filesystem or ambient Pi directories directly.
Hosts must keep session visibility, transcript size, cache retention, and
optional model facet submission explicit.

The generated report is a self-contained `file://` snapshot dashboard. Every
`/insights` invocation rescans visible root and retained subagent transcripts,
reparses new or changed files, and replaces the report. Unchanged files reuse
parser-versioned metadata. Opening the generated HTML later does not reread live
files. `--refresh` is only a force-reparse option for unchanged files.

It includes the
Felan-branded activity calendar, daily/hourly/model/project/rage charts,
date presets and custom ranges, session search, sortable project breakdowns,
and light/dark theme switching. When the local host has Savings measurements,
the report also includes filterable avoided-cost, producer, category, project,
daily, and measurement-detail breakdowns. Savings are estimated
API-equivalent cost avoided, not an invoice or guaranteed billing reduction;
unpriced measurements are shown as incomplete.

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
