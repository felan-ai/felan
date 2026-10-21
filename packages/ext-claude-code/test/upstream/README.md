# Upstream unit-test port

Source: `pi-claude-bridge` 0.9.3, commit `874fa7c2678456336f23b64e784e2057e608d83e` (MIT; see package LICENSE/NOTICE).

Baseline: `cd /tmp/pi-claude-bridge && npm run test:unit`: **330 passed**.
Port: **306 passed in 40 files**. The difference is 17 removed AskClaude tests and 7 removed file-config/notice tests. No retained tests are skipped.

Run from this package with `pnpm type-check && pnpm test`. The package suite also includes SDK, managed-install, and other Felan-owned tests.

Verified with Node 22.20.0 and pnpm 9.15.5:

- Initial port: `pnpm build && pnpm type-check && pnpm test` passed; 44 files, 379 tests (306 upstream, 10 SDK, 27 managed-install, 15 command, 21 extension).
- After the Felan runtime adaptations: the same commands passed; 45 files, 415 tests, including 36 new `bridge-felan` tests. All 306 ported upstream tests remain enabled and pass.
- After the prompt-routing and lifecycle fixes: the same commands passed; 45 files, 455 tests, including 50 `bridge-felan` tests and all 306 ported upstream tests.
- After lifecycle-based routing and npm-reachable guidance: the same commands passed across all 45 files, including 61 `bridge-felan` tests and all 306 ported upstream tests.
- `git diff --check -- packages/ext-claude-code/test/upstream packages/ext-claude-code/test/setup.ts packages/ext-claude-code/vitest.config.ts`: passed.
- All 40 retained upstream unit files are mapped. No `node:test`, direct Pi package imports or obsolete default activations remain in the port.

## Common adaptations

- Every retained `unit-*.mjs` maps to the same basename plus `.test.mjs` below. `node:test` hooks become Vitest hooks; `t.after` becomes `onTestFinished`. The 10-second suite timeout covers upstream per-test timeouts.
- Source imports use `../../src/bridge/*.ts`; SDK setup uses the local runtime injection seam. Provider IDs/API/base URL become `claude-code`; internal upstream symbols and diagnostic filenames retain their names.
- Activations use `activateClaudeCodeBridge(pi, { settings, agentDir })`, directly or via `lib/mock-pi.mjs`. SDK queries are explicit fakes via `__test.setQuery`; `lib/fake-sdk.mjs` injects MCP handler registration and rejects any unexpected query. No Claude Code process or managed SDK is loaded.
- Vitest isolates files in fork workers. `test/setup.ts` gives each file temporary HOME, USERPROFILE, FELAN_HOME, Pi agent/session dirs, CLAUDE_CONFIG_DIR and debug paths. Before each upstream test it resets mirrors/rewrite marks/query overrides and reinstalls the fake SDK.
- Pi package API imports use `@felan-ai/agent-core`. Models use `builtinProviders()` instead of compatibility `getModels()`. The installed-Pi inventory and prompt-rendering probes resolve their existing internal file paths relative to `@felan-ai/agent-core`, rather than assuming Pi is a direct dependency.

## Dropped unit tests

These are omitted, not silently marked passed.

### Removed AskClaude feature (17)
Entire `unit-askclaude-schema.mjs`; the schema, presets and tool no longer exist:

- keeps the existing descriptions
- offers every mode and tags nothing on a bare call
- tags explicit non-default options
- states full as the default
- shows inherited write access and a read-only override in the status line
- states isolation as the default
- shows inherited isolation in the status line
- removes full from the schema
- overrides a conflicting full default
- rejects full mode during execution even if a caller bypasses the schema
- fails closed for a malformed non-boolean allowFullMode
- keeps the package default true for a null or omitted allowFullMode
- states and renders none as the default mode, including an explicit read escalation
- falls back to generated text for a null description
- returns a non-null configured description verbatim
- treats a null configured mode as unset, falling back to the package default
- fails closed for an invalid configured mode

### Removed bridge-owned file configuration/notices (7)
`unit-config.mjs` retains both `claudeCodeSettings` tests. The extension now receives settings from Felan; it does not merge/write `claude-bridge.json` or persist notices:

- loads project config from Pi's configured project directory
- merges project config over global config
- markStartupNoticeShown records today's date without dropping existing settings
- markAskClaudeDeprecationNoticeShown records today's date without dropping settings
- markStartupNoticeShown leaves an unparseable config untouched
- markStartupNoticeShown creates the config when there is none
- resolves global config via PI_CODING_AGENT_DIR override, not hardcoded ~/.pi/agent

## Rewritten test coverage

All counts below are included in the 306 retained tests. Shared import/provider/hook/API migrations are listed above and apply to the file inventory below.

### Activation-owned log paths (4)
`unit-debug-path.test.mjs`: removed globalConfigPath assertion because file configuration no longer exists; paths are now rooted in activation agentDir. The former subprocess/tsx probe is an in-process activation test; lazy debug overrides remain covered.


### Injected MCP boundary (14 + 8)
`unit-mcp-server.test.mjs` retains all 14 schema/routing assertions but calls the real bridge handlers through the injected fake MCP server, not the proprietary managed SDK transport. Actual SDK JSON-RPC serialization is not claimed by these tests.

- rejects a non-object parameter schema at construction, naming the tool
- preserves top-level properties and required
- preserves object properties nested in an array
- preserves nested object properties, enums and required
- preserves anyOf branches
- flattens a top-level anyOf into one object schema CC accepts
- keeps allOf requirements, which apply to every call
- flattens a oneOf of $defs refs and names each group in the description
- leaves the description alone when there is no top-level combinator
- routes tools/call to the matching handler
- hands the handler Claude's tool_use id, not one inferred from call order
- fails loudly when the tool_use id is absent rather than mispairing
- does not leak internal fields into the tool result
- invokes the handler even when arguments do not match the schema

The following eight `unit-queue.test.mjs` tests likewise use injected MCP handlers; the other three still test transcript result extraction directly:

- hands a handler the result that arrived before it, isError included
- parks a handler that arrives before its result, then releases it
- pairs parallel calls by tool_use id, not by call or delivery order
- moves an id between the maps without ever holding it in both
- leaves only the unanswered handler parked when a result never arrives
- answers every parked handler and forgets queued results
- unwedges a delivery parked on the steer ack, leaving no handler waiting
- releases every parked handler for a turn scraped out of context

### Public Felan session composition (7)
The direct Pi `createAgentSession` export is not part of agent-core. `lib/session.mjs` uses public `createAgentCoreSession`, a temporary HostAgentRuntime and inline extensions; native summarization/compaction assertions remain real, with only SDK queries faked.

- `unit-compaction-coexistence.test.mjs`: `compaction owner: extension`, `native`, `declining-extension`, `cancel`, `error`.
- `unit-summary-cwd.test.mjs`: concurrent native `compaction` and `branch summary` queries use their owning session's cwd.

### Other targeted adaptations

- `unit-error-result.test.mjs` / `is named as a rate limit so fallback chains fire`: retain rate-limit labeling, stop reason, raw error text and absence of tool-failure prefix. Drop only the call to Pi-internal `isRetryableAssistantError`, which is not an agent-core export; host retry policy is outside this extension.
- `unit-import.test.mjs` / `tool name mapping: unserved pi tools keep the MCP namespace`: replace the removed AskClaude example with `retired_tool`, retaining the generic unserved-tool namespace assertion.
- `unit-skills.test.mjs` / `keeps the native read-tool instruction for isolated queries`: renamed from `... for AskClaude`; this tests the retained generic native-read rendering utility, not AskClaude.
- `unit-session-cwd.test.mjs` / `shares the store across module instances via globalThis`: use a static cache-busting module query instead of a Date.now() dynamic import that Vite cannot analyze.
- `unit-convert-determinism.test.mjs`: move the required pure transcript/prefix helper from `diag/lib/write-path.mjs` into `lib/write-path.mjs`; no diagnostic runner is included.

### Felan prompt routing and guidance

Felan routes tool-free, single-user-message calls to isolated queries only when their session ID is not tracked from `session_start`. Prompt captures do not select the route. These fixtures explicitly model live provider sessions without changing their original assertions:

- `unit-cross-session-turns.test.mjs`: the call helper emits `session_start` once per session and supplies a fake system-prompt capture before each provider call. Each scripted query exits after its result without reading another prompt, so a session's next prompt takes Felan's live-process fallback and reruns on a fresh query. All five cases continue testing persistent session isolation, resumption and rebuild behavior.
- `unit-prompt-capture-turn-failure.test.mjs`: each test emits `session_start`, so an uncaptured, tool-free request still exercises provider fail-closed behavior rather than the isolated route.
- `unit-prompt-guard.test.mjs`: troubleshooting assertions point to the shipped `@felan-ai/ext-claude-code` README (Compatibility section) and `/claude-code status`; the guard assertions are unchanged.

## Intentionally out of scope

All upstream `int-*` files are excluded: these are integration/real-Claude-Code runs, not the offline unit suite:

- `int-attachment-rebuild.mjs`
- `int-branch-summary.mjs`
- `int-cache-git.sh`
- `int-cache.sh`
- `int-cc-contracts.mjs`
- `int-compact-auto-threshold.mjs`
- `int-compact-baseline.mjs`
- `int-compact-midturn-rebuild.mjs`
- `int-compact-second-compact.mjs`
- `int-compact-splitturn.mjs`
- `int-cursor-after-tools.mjs`
- `int-image-session.mjs`
- `int-multi-turn.sh`
- `int-parallel-tool-results.mjs`
- `int-served-window.mjs`
- `int-session-compact.mjs`
- `int-session-new.mjs`
- `int-session-rebuild.mjs`
- `int-session-resume.mjs`
- `int-shutdown-kills-cc.mjs`
- `int-smoke.sh`
- `int-subagent-rpiv-codebase-locator.mjs`
- `int-tool-message.mjs`

All `diag/` runners, probes and reports are excluded. Only the pure `transcript`/`settledPrefixes` helper needed by unit determinism coverage is relocated into `lib/`. Also omitted: unused integration harness/recording helpers and fixtures. Included fixtures are `pi-history-310.jsonl`, the codebase-locator agent Markdown, and the three recorded SDK streams.

## Felan runtime adaptations

`../bridge-felan.test.mjs` adds focused coverage alongside the retained upstream tests:

- **Registration**: every activation immediately registers into its own registry; repeated activations share one stream function. `unit-provider-registration` replaces the three upstream first-instance/deferred-registration assertions with immediate-registration assertions.
- **Per-session lifecycle**: new/resume/fork clear only the owning session's mirror, rewrite mark and old cwd, then capture its new cwd/UI. Shutting down A preserves B's mirror, mark, cwd and UI. Late query completion, failure or abort cannot recreate a cleared mirror or change its replacement. Verification and rate-limit notifications use the query's session, never another session or a closed UI. Existing cross-session, discard, sync and summary suites retain their coverage. `unit-sync-shared-session` now attributes its verification-notification fixture to a named session.
- **Child environment**: provider and isolated queries share the environment builder. Both suppress nonessential traffic and strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` unless explicitly inherited. Activation and queries leave `process.env` unchanged. `unit-child-env` adds the traffic-suppression constant assertion.
- **Prompt-only routing**: after transcript normalization, no tools, exactly one user message and a session ID not tracked from `session_start` select the isolated path, preserving text-plus-image and image-only inputs. Undefined and synthetic `felan-models:` IDs are never tracked; even exact or embedded captures in these calls stay isolated without creating a mirror. Live sessions, including children, retain provider capture validation and fail closed on missing captures. Shutdown and explicit session reset remove lifecycle tracking; an SDK failure that only clears a mirror does not. `cacheRetention: 'none'` continues selecting isolated summaries, including for live sessions. Isolated prompts reject the same Pi preamble and docs-path pair as captured prompts. Mid-line references and single docs paths remain valid. Troubleshooting messages refer to the shipped README (Compatibility section) and `/claude-code status` while retaining diagnostics.
- **Authentication errors**: success-shaped errors, dedicated error results and synchronous/asynchronous SDK failures receive local `claude` then `/login` guidance. Inherited credentials add an `inheritAnthropicEnvironment` hint, using the query's own environment even if settings subsequently change. Successful text and unrelated failures remain untouched.
- **Settings**: the latest activation's settings apply to queries through an earlier registration, on both provider and isolated paths.

All 306 ported tests remain retained. No conversion, prefix-cache stability, tool-result pairing, cancellation/rebuild or replay assertions were removed.

## Ported files

| File | Tests |
| --- | ---: |
| `unit-agent-start-capture-gaps.test.mjs` | 6 |
| `unit-agent-start-capture.test.mjs` | 5 |
| `unit-agents-md.test.mjs` | 2 |
| `unit-attachments.test.mjs` | 8 |
| `unit-child-env.test.mjs` | 1 |
| `unit-compaction-coexistence.test.mjs` | 6 |
| `unit-config.test.mjs` | 2 |
| `unit-convert-determinism.test.mjs` | 6 |
| `unit-cross-session-turns.test.mjs` | 5 |
| `unit-deadlock-log-gate.test.mjs` | 4 |
| `unit-debug-path.test.mjs` | 4 |
| `unit-deliver-tool-results.test.mjs` | 7 |
| `unit-discard-rewritten-query.test.mjs` | 14 |
| `unit-error-result.test.mjs` | 14 |
| `unit-import.test.mjs` | 40 |
| `unit-isolated-effort.test.mjs` | 5 |
| `unit-mcp-server.test.mjs` | 14 |
| `unit-models.test.mjs` | 22 |
| `unit-nonstreaming-fallback.test.mjs` | 4 |
| `unit-orphan-result-after-restart.test.mjs` | 6 |
| `unit-pi-streamfn-inventory.test.mjs` | 1 |
| `unit-prompt-blocks.test.mjs` | 5 |
| `unit-prompt-capture-turn-failure.test.mjs` | 2 |
| `unit-prompt-capture.test.mjs` | 25 |
| `unit-prompt-guard.test.mjs` | 6 |
| `unit-prompt-stream.test.mjs` | 8 |
| `unit-provider-registration.test.mjs` | 3 |
| `unit-querycontext.test.mjs` | 3 |
| `unit-queue.test.mjs` | 11 |
| `unit-rate-limit.test.mjs` | 7 |
| `unit-session-cwd.test.mjs` | 5 |
| `unit-session-integrity.test.mjs` | 8 |
| `unit-skills.test.mjs` | 4 |
| `unit-stream-replay.test.mjs` | 9 |
| `unit-summary-cwd.test.mjs` | 2 |
| `unit-sync-shared-session.test.mjs` | 4 |
| `unit-transcript-replay-order.test.mjs` | 8 |
| `unit-unfinished-tool-call.test.mjs` | 5 |
| `unit-unserved-tool-use.test.mjs` | 3 |
| `unit-usage.test.mjs` | 12 |
