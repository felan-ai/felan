# TUI parity testing

Manual-style end-to-end comparison of the daemon TUI against the released in-process TUI (0.28.3). Both TUIs run side by side in `tmux`, receive the same steps, and are captured as text frames with timestamps so layout, text, color, appearance order and behaviour can be compared without images.

This is an investigation tool, not a CI gate. Findings are classified by a person or agent and turned into fix tasks.

## Isolation

Every run lives under `/tmp/felan-parity/<run-id>/`. The real home is resolved with `os.userInfo().homedir`, not `$HOME`. The harness never writes credentials back to the real `~/.felan`.

- **Private homes:** each side gets a fake HOME, copied `.agents/skills` (no symlinks into the real home), and a minimal gitconfig containing only a fixture identity. Panes use `env -i` and an explicit environment. `PI_OFFLINE=1` is set on both sides; it is not a guarantee against paid model calls.
- **Seed checks:** only `auth.json`, `models-store.json` and `settings.json` are seeded. Any string in settings or the model store containing the real home path causes refusal; diagnostics show key paths, not values. No MCP config is copied, and each agent directory is checked for MCP config before launch.
- **OAuth:** by default only the default model's provider and providers referenced by the settings' default model or Fusion lineup are seeded. `--providers NAME,NAME` overrides this set. Any seeded OAuth credential without a valid expiry, or expiring within `--max-run-hours` (default 4) plus a one-hour margin, causes refusal. The maximum duration is enforced at step/wait boundaries. At cleanup every sandbox auth file is compared with the in-memory seed, including removals and additions. Changes FAIL the run with `credentials were refreshed in the sandbox; the real login for <provider> may need /login`. Never bypass this check or copy a sandbox credential back.
- **Old side:** `FELAN_AGENT_DIR=<run>/old-agent`. **New side:** explicit `--daemon-runtime <run>/new`; bootstrap creates the target before seeding. The daemon stops after every scenario and starts cold before the next, against the same target. Settings on both sides are reseeded before each scenario. Session/history files and the ordinary scratch workspace persist; `B-trust` uses its own fresh workspace. Auth is not silently reseeded after logout.
- **Launch and timing:** both panes wait behind private tmux gates while raw recording is attached, then are released together. Each side records its own pre-exec launch timestamp. Frames measure elapsed time from that timestamp; polling resolution is about 150 ms, not event-level precision. `run.json` records versions, environment keys, `PI_OFFLINE`, git HEAD/dirty status, dist/CLI mtimes, daemon cold-start policy and launch times.
- **Entry guard:** in-memory before/after path, size and mtime snapshots identify additions, removals and metadata changes. Only the diff is published. Additions/removals under `sessions/`, `subagents/`, `storage/sessions/`, subscription-usage reclaim/release lease paths, rotating `storage/agent/savings/v1/writers/<id>/<n>.json` files, codebase-memory `.worker-log-*`/`.worker-response-*` cache scratch files, and `storage/agent/codebase-memory/cache/logs/*.log` files are reported as concurrent activity, not fatal. All other additions/removals remain fatal.
- **Content guard:** added and metadata-modified regular files, including concurrent-activity additions, are scanned for the run ID, run root, fake homes and workspaces. Hits and read errors FAIL. Files that vanish before inspection FAIL unless their paths match the same concurrent-activity rules; those are recorded separately as `concurrentVanished`, not silently ignored. Files over 16 MiB are explicitly excluded; directories and symlinks are not read. This detects only marker-bearing writes: settings toggles, usage counters and unrelated credential changes without a marker can be invisible. Metadata sampling is not continuous filesystem auditing.
- **Process guard:** sampled every 250 ms and at lifecycle boundaries. Environments are read only for new identities; a final batched `ps -E` sweep finds surviving detached processes containing the run root. Both TUI clients and the new daemon must have been observed with verified HOME/agent directory. On macOS, an unreadable environment is reported as `inherited, not inspectable` only when the executable is under `/bin/`, `/usr/bin/`, `/sbin/`, `/usr/sbin/` or `/System/` and its current same-UID parent chain reaches a process whose environment was verified for the same sandbox side. The executable comes from `ps comm`; for a bare name such as `sleep`, the first `lsof -a -p PID -d txt -Fn` file must match that name and PID. These rows are not violations and cannot satisfy required roles. An unreadable process without that ancestor, a non-platform executable, or a readable environment with invalid HOME/agent directory still FAILS. PID, UID, start time, command and sandbox environment are rechecked before signalling. Unverified and inherited-but-uninspectable processes are never signalled; survivors or inspection failures retain the sandbox without credentials/private raw captures. Short-lived processes between samples cannot be certified.

A fake HOME does **not** isolate the macOS login keychain. Released MCP OAuth code can access `@napi-rs/keyring` service `felan.mcp.oauth`. Do not configure or authenticate MCP in these runs. Login provider drill-down is forbidden. The harness does not deliberately invoke the keychain, but HOME isolation alone cannot prove that dependencies never do.

Isolated daemon targets still create coordinator lock files in `/private/tmp/felan-<uid>-daemon-v1`. They may accumulate alongside production files. **Never delete or edit coordinator files**, including `isolated-*.lock` or `claims-*.tmp`.

## How to run

Prerequisites: Node.js 22.23.4, pnpm 9.15.5, tmux, installed 0.28.3 `felan`, and a completed workspace build. Build once before any run; nobody runs `pnpm build` or edits `dist` while runs are active. No additional npm dependencies are required.

```sh
parity() {
  log=$(mktemp /tmp/felan-parity-output.XXXXXX)
  chmod 600 "$log"
  if node scripts/tui-parity/run.mjs "$@" >"$log" 2>&1; then status=0; else status=$?; fi
  cat "$log" # Only after the harness exits.
  printf 'exit=%s; log=%s\n' "$status" "$log"
  return "$status"
}
parity --self-test
parity --dry-run
parity # Smoke: only paid prompt is "say hi", once per side.
```

Use the same private-log pattern for `--scenario ID` or `--area A|B|C|D`. Omit `--id`; IDs are generated internally and never reused. `--old-bin /absolute/path/to/felan` selects another released executable. Do not edit the real account or reduce the safety margin to force a run. Resolve seed refusals with the user; an explicit provider override may narrow a run to the providers its scenarios actually need.

`--dry-run` validates the catalog without launching either TUI. `--self-test` covers expiry boundaries, credential changes, home-path detection, concurrent-activity classification and vanished files, non-fatal waits, bounded stop commands, verified SIGTERM/SIGKILL escalation, refusal to signal unverified processes, retained credential scrubbing, partial reports, redaction, parsing, catalog coverage and process checks. Commands and Escape wait for an unchanged screen for at least 500 ms, bounded by a timeout. Settle timeouts record `screen did not settle within N ms` and continue; animated views must not abort a scenario. Selectors, history and `ask_user` use independent per-side text waits; absent UI records `"<text>" not shown within N ms` and continues. Startup and idle timeouts remain fatal. Idle requires an unchanged screen for 2.5 seconds and no busy indicator in the bottom six rows; this does not prove model success.

### Rules for the area agents

1. Run only after the safety fixes and the required smoke verification pass. Build once beforehand; freeze `dist` for all runs.
2. The orchestrator starts all four agents before any run begins. Agents do not spawn subagents during runs. Avoid new user sessions to reduce concurrent noise (new session paths are reported, not silently ignored).
3. Each agent runs one harness process at a time. Omit `--id`. Never use `--update-command-table` during area runs: it edits this document. Maintainer-only table updates require a completed successful command-capture run.
4. Redirect output to a private `mktemp` file. Do not read, print or mention the run directory or run ID until the harness exits; doing so can itself produce a content hit in the orchestrator transcript.
5. Use `--allow-paid` only for your assigned area. Run `B-model`, `B-settings`, `B-themes`, `B-logout-nav` and `B-trust` individually with `--scenario`. Settings resets and cold daemon restarts reduce carryover but do not reset all session/history state. Treat `D-insights` and `D-memory` as possibly paid; the catalog gates them accordingly. Logout may remove a credential immediately and therefore intentionally trigger the credential-change guard.
6. Never use broad `pkill`/`killall`, unscoped `tmux kill-server`, or `daemon stop` without your own `--daemon-runtime`. Do not touch real `~/.felan`, `/tmp/felan-try`, `/private/tmp/felan-<uid>-daemon-v1`, or another run's `/tmp/felan-parity/<id>`. Do not interact with sandbox TUIs by hand, run `/login <provider>`, or press Enter on a login provider.
7. On a content hit, process violation or credential-change failure, stop the other runs through their own harness cancellation paths and report to the user. Report concurrent-activity additions/removals even when the guard passes. All other entry changes, content-read failures and non-concurrent vanished-file checks remain fatal: do not waive or silently retry them.
8. `passed` means steps completed, not parity. Compare checkpoint text/ANSI, normalized unified diffs, SGR summaries, frames and timeline. Account for per-side launch timestamps, poll resolution, bounded settling, cold-daemon startup, retained history and `PI_OFFLINE=1`. Review trust before **and after** Enter; trust observations are unclassified, not automatically intentional. Ctrl+Shift shortcuts are marked **shortcut not sendable** rather than falsely claimed tested; compare the slash-command views as well.
9. Do not commit or share artifacts externally. Credentials and emails are masked, and full home snapshots are not saved, but model prose, account labels, changed paths and process metadata may remain private.
10. If the harness hangs or is killed, report it. SIGINT/SIGTERM request scoped cleanup; SIGKILL cannot. Never clean another run's sandbox. Retained sandboxes require supervised inspection after their isolated processes have stopped.

Every scenario, successful or aborted, writes reports for its captured checkpoints before teardown. Cleanup sends Escape three times to both panes, with 200 ms settles, before closing them. It stops only the explicit isolated target: drain and scoped force are each limited to 5 seconds, with at most one 3-second status check after force failure. If force is still blocked, `daemon-cleanup.json` records the product finding `force stop blocked: <status>`; this alone does not abort later scenarios or retain the sandbox. After a 5-second grace period, surviving processes are revalidated by PID, UID, start time, command, sandbox HOME and sandbox FELAN_AGENT_DIR before SIGTERM, then SIGKILL after a 1-second grace. Unverified processes are never signalled. Unsafe or incomplete process cleanup retains the sandbox; verified cleanup removes it. Only this run's private tmux server is closed.

Guard inspection and final redaction still run after cleanup failure. Retained sandboxes are recursively scrubbed of every `auth.json`, `models-store.json`, `settings.json` and private raw capture, including daemon-side copies and matching symlinks, without following directory symlinks. A second scan verifies none remain; `sandbox-scrub.json` records the removed paths and verification. Scrub failures fail the run. The real login is never repaired automatically.

Raw chunks are recorded privately, then redacted across chunk boundaries before publication; emails are length-preservingly masked too. Updated sandbox credentials are collected for final re-redaction. Inspect model prose manually; it is not normalized away.

## Scenario format

Scenarios live in `scripts/tui-parity/scenarios/<area>.mjs` and export an array:

```js
export default [{
  id: 'A-startup',
  area: 'A',
  title: 'Startup header, editor and footer',
  steps: [
    { wait: { text: 'Felan Code', timeoutMs: 15000 } },
    { checkpoint: 'startup' },
    { keys: '/' },
    { wait: { settle: true, timeoutMs: 15000 } },
    { checkpoint: 'slash-list' },
    { keys: ['Escape'] },
  ],
  observe: ['header lines', 'editor borders', 'footer three lines', 'slash list labels and descriptions'],
  intentional: ['daemon-only commands (/daemon, /restart, /close)', 'version strings'],
}];
```

Step kinds:

- `{ text: string }`: type literal text (no Enter).
- `{ keys: string | string[] }`: `tmux send-keys` key names, for example `Enter`, `Escape`, `C-c`, `M-a`, `C-r`.
- `{ prompt: string }`: type the text and press Enter. Keep prompts simple, for example "start a subagent that lists the files here" or "run sleep 20 in the background".
- `{ wait: { ms } | { text, timeoutMs, onTimeout?: 'observe' } | { settle: true, timeoutMs } | { idle: true, timeoutMs } }`: fixed wait, per-side text wait, 500 ms unchanged screen, or 2.5 s unchanged without a bottom-row busy indicator. `until()` and `command()` selector waits use `onTimeout: 'observe'`; only an explicitly strict text wait aborts. All settle timeouts are observations; idle remains strict. Missing UI does not prove later navigation or selection succeeded; review the checkpoints.
- `{ checkpoint: name }`: store the current screen of both sides under that name.
- `{ resize: [columns, rows] }`: resize each selected tmux window.
- `{ commands: true }`: scroll the open slash list until its position counter wraps, saving every page and both extracted lists.
- `{ blocked: reason }`: record an unexecutable action and skip subsequent driving on that side (checkpoints remain available).
- `{ side: 'new', daemonStop: 'force' }`: run `daemon stop --force` against this run's explicit isolated target while the current view remains open. Record the bounded command in `daemon-cleanup.json`; do not dismiss the view or send process signals. Ordinary scoped teardown still runs afterwards.
- `{ side: 'old' | 'new', ... }`: optional on any step when the two TUIs need different keys for the same action (record why in `intentional`).

## Report

Artifacts go to `.parity/<run-id>/` (gitignored; not `.artifacts/`, which `pnpm verify` deletes when packing):

- `<scenario>/<checkpoint>.{old,new}.txt` and `.ansi`: final screens per checkpoint. Matching `.meta.json` records the step and cumulative per-side timeout observations; `scenario.json` includes all observations.
- `<scenario>/frames.{old,new}.jsonl`: deduplicated screen frames with milliseconds since the step started and that side launched.
- `<scenario>/timeline.md`: first appearance of each normalized line on each side, sorted by earliest appearance across either side.
- `<scenario>/diff.md`: unified checkpoint diffs after masking ids, versions, costs, token counts, durations, timestamps and sandbox paths. Matching `.normalized.txt` files and per-line `.sgr.json` colour summaries are saved, including partial checkpoints when a scenario aborts. Model prose remains visible for manual comparison.
- `<scenario>/raw.{old,new}.jsonl`: redacted raw terminal chunks, with wall-clock and relative timestamps.
- `index.md`, `verification.md`, `run.json`, `guard.*.json`, `daemon-cleanup.json`: navigation, guard verdicts, run metadata, entry diffs, content/process/credential checks and shutdown diagnostics. Full snapshots are never published.
- `findings.md`: unclassified observations and evidence paths. Agents assign classification (`regression`, `intentional`, `old-bug`, `improvement`, `unsure`), severity and suspected location after inspection.

Timing resolution is the frame poll interval (about 150 ms). Model output differs between runs, so compare structure and behaviour, not wording.

## Feature areas

- **A — shell and basics:** startup header, editor borders, scroll and resize, footer, autocomplete and skills, Esc / Ctrl+C / Ctrl+D / Ctrl+O, streaming, working indicator, thinking, tool display, `!` and `!!`, notices.
- **B — sessions and configuration:** `/model` (Enter vs Ctrl+S), `/thinking`, `/settings`, `/login` and `/logout` (navigate and cancel only), session commands, prompt history (Ctrl+R), themes, folder trust.
- **C — agents and processes:** subagents (spawn, rail, Alt+A navigator, completion notice), background processes (`/processes`, Ctrl+Shift+J), tasks (`/tasks`, Ctrl+Shift+T), `ask_user`, Prewalk, tool inspector (`/tools`, Alt+T).
- **D — extension views:** memory, `/context`, `/insights`, `/savings`, `/fusion-models` and one short `/fusion`, web search (browser not covered), `/mcp`, `/markitdown`, `/progressive-context`, `/rtk`, codebase-memory, `/dependencies` (Codex tools not covered).


## Command comparison

Built-in commands from the live `/` lists. "Only new" or "only old" entries are candidates for scenarios or "not comparable" notes.

<!-- command-comparison:start -->
Captured live with `node scripts/tui-parity/run.mjs --id verified-smoke --update-command-table`. Full scrolled lists and frames: `.parity/verified-smoke/`.

The table includes commands only; both lists also contain 29/29 skill rows (old/new). Long skill labels are truncated by the TUI and preserved as displayed in the JSON evidence.

| Command | 0.28.3 | Daemon TUI | Note |
| --- | --- | --- | --- |
| `/agents` | yes | no | old-only in live list |
| `/bug` | yes | no | old-only in live list |
| `/cancel` | no | yes | new-only in live list |
| `/changelog` | yes | no | old-only in live list |
| `/clone` | yes | no | old-only in live list |
| `/close` | no | yes | new-only in live list |
| `/codebase-memory` | yes | yes |  |
| `/compact` | yes | yes |  |
| `/context` | yes | yes |  |
| `/copy` | yes | no | old-only in live list |
| `/cwd` | yes | yes |  |
| `/daemon` | no | yes | new-only in live list |
| `/dependencies` | yes | yes |  |
| `/exit` | no | yes | new-only in live list |
| `/export` | yes | no | old-only in live list |
| `/follow-up` | no | yes | new-only in live list |
| `/fork` | yes | yes |  |
| `/fusion` | yes | yes |  |
| `/fusion-models` | yes | yes |  |
| `/help` | no | yes | new-only in live list |
| `/history` | no | yes | new-only in live list |
| `/hotkeys` | yes | no | old-only in live list |
| `/import` | yes | no | old-only in live list |
| `/insights` | yes | yes |  |
| `/llama` | yes | yes |  |
| `/login` | yes | yes |  |
| `/logout` | yes | yes |  |
| `/markitdown` | yes | yes |  |
| `/mcp` | yes | yes |  |
| `/memory` | yes | yes |  |
| `/model` | yes | yes |  |
| `/name` | yes | no | old-only in live list |
| `/new` | yes | yes |  |
| `/prewalk` | yes | yes |  |
| `/processes` | yes | yes |  |
| `/progressive-context` | yes | yes |  |
| `/prompt-history` | no | yes | new-only in live list |
| `/quit` | yes | no | old-only in live list |
| `/reconnect` | no | yes | new-only in live list |
| `/reload` | yes | yes |  |
| `/rename` | no | yes | new-only in live list |
| `/restart` | yes | no | old-only in live list |
| `/resume` | yes | yes |  |
| `/rtk` | yes | yes |  |
| `/savings` | yes | no | old-only in live list |
| `/scoped-models` | yes | no | old-only in live list |
| `/session` | yes | no | old-only in live list |
| `/sessions` | no | yes | new-only in live list |
| `/settings` | yes | yes |  |
| `/share` | yes | no | old-only in live list |
| `/steer` | no | yes | new-only in live list |
| `/tasks` | yes | yes |  |
| `/thinking` | yes | yes |  |
| `/tools` | yes | no | old-only in live list |
| `/tree` | yes | yes |  |
| `/trust` | yes | no | old-only in live list |
| `/ui` | no | yes | new-only in live list |
<!-- command-comparison:end -->

The captured list shows `/restart` only on 0.28.3; absence from autocomplete does not establish whether a typed command is supported.

The current daemon TUI displays queued `Steering:` and `Follow-up:` lines above the editor instead of a read-only queue command. Alt+Up restores all queued messages before the current draft. Escape restores them before cancelling a running turn; cancellation still runs if restoration fails. Restoration requires the daemon's `queue.clear` capability, and its hint is hidden when that capability or keybinding is absent.

Model cycling defaults are Ctrl+P forward and Ctrl+Shift+P backward. Alt+P is not a default model shortcut because its legacy terminal sequence, `\x1bp`, also matches Alt+Up.

Known intentional differences: daemon commands (`/daemon`, `/restart`, `/close` versus `/exit` detach), the version string, and model-generated prose.

## Scenario catalog

Scenario IDs are stable across runs. Each row is implemented in `scripts/tui-parity/scenarios/<area>.mjs`. The "Observe" column lists what the agent compares on both sides.

| ID | Area | Steps | Observe |
| --- | --- | --- | --- |
| A-startup | A | start, wait for header | header lines, footer three lines, editor top and bottom borders |
| A-slash-list | A | type `/` | labels without leading slash, descriptions, ordering, skill entries (`skill:<name>`) and count |
| A-autocomplete-filter | A | `/mo` then Esc | fuzzy filter, highlight, Esc clears |
| A-file-autocomplete | A | type `@exa` and select a file; on a later line type `exa` then Tab; cancel with Esc | fuzzy `@` search when `fd`/`fdfind` is available, direct Tab path completion, quoted paths, multiline edits, and active-session cwd changes |
| A-editor-clear | A | type `/hotkeys` (or `/help`), Enter | editor empties after submit, command added to history (Ctrl+R) |
| A-streaming | A | prompt "say hi in five words" | working indicator text and timing, streamed text, footer tokens and cost update |
| A-tool-display | A | prompt "list the files in this directory" | tool row layout, Ctrl+O toggles preview, completion line |
| A-bash | A | `!echo hi`, then `!!echo hi` | output placement, context inclusion difference between `!` and `!!` |
| A-keys | A | Esc while running, Ctrl+C, Ctrl+D | cancel behaviour, exit or detach wording, notices |
| A-resize | A | resize terminal to 80x24 and back | editor and footer reflow, no overlap, no clipped border |
| A-long-input | A | 12-line pasted-style input with `C-j` | editor growth, scroll inside editor, borders kept |
| A-notices | A | trigger an unknown command | notice text and colour |
| B-model | B | `/model`, Enter on a row, Ctrl+S on another | selector layout, default vs session-only wording, footer model |
| B-thinking | B | `/thinking` | options, current value, footer update |
| B-settings | B | `/settings`, open general, change a toggle, Esc | layout, delimiters, search prompt, counts, immediate save |
| B-login-nav | B | `/login`, choose account, back, cancel | type-first order, provider list filtering, back navigation, no login completed |
| B-logout-nav | B | `/logout`, cancel | list contents, cancel behaviour |
| B-sessions | B | `/new`, `/sessions` or `/resume`, `/rename x`, `/fork` | session list layout, names, fork notice |
| B-resume | B | seed 12 pre-daemon transcripts, `/resume`, scroll, Tab, Ctrl+P, resize to 120x24 | stable viewport, counter, first-message labels, age metadata, folder only in All scope |
| B-tree | B | `/tree` after two prompts | tree layout and navigation keys |
| B-history | B | Ctrl+R after two prompts | picker layout, scopes, selection inserts text |
| B-themes | B | `/settings` theme row | theme list, preview, live colour change |
| B-trust | B | start in a folder with an untrusted `AGENTS.md` or skill | trust prompt wording, choices, what loads after trust |
| C-subagent | C | "start a subagent that lists the files here" | spawn notice, rail or indicator, Alt+A navigator, completion message |
| C-background | C | "run sleep 20 in the background" then `/processes` | process row, Ctrl+Shift+J view, completion notice |
| C-tasks | C | "create two tasks: write a note and check it", `/tasks` | task list, detail, Ctrl+Shift+T |
| C-ask-user | C | "ask me a yes/no question with ask_user" | inline versus overlay, layout, answer rendering in transcript |
| C-prewalk | C | `/prewalk status`, `/prewalk exit` | status layout, exit notice |
| C-tools | C | after a tool call, Alt+T and `/tools` (old only; new blocked) | inspector layout and arguments/results display |
| D-memory | D | `/memory` | status layout, pending counter, footer status line |
| D-context | D | `/context` | inline or overlay placement, layout |
| D-insights | D | `/insights` | view layout, charts, filters |
| D-savings | D | `/savings` | value wording and layout |
| D-fusion-models | D | `/fusion-models` (no requests) | search layout, saved lineup |
| D-fusion | D | one short `/fusion` prompt | progress display, review layout |
| D-web | D | one web search prompt | tool row, result rendering |
| D-mcp | D | `/mcp status` | status layout, empty-state wording |
| D-markitdown | D | `/markitdown` | status layout |
| D-rtk | D | `/rtk show` | status layout |
| D-codebase-memory | D | `/codebase-memory` | status layout |
| D-dependencies | D | `/dependencies`, Esc | checklist layout and wording |
| D-progressive-context | D | `/progressive-context` | list layout |

The harness owns the exact keys and waits. A scenario that cannot run on one side is recorded as `blocked` with the reason, not dropped.
