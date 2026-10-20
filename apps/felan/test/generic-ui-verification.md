# Generic client verification packet

This packet identifies focused generic-UI checks. Run through
`scripts/test-isolated.sh` after dependency builds. These focused tests do not
launch a daemon, browser, keyring, model, or process job.

## Automated evidence

| File | Coverage |
| --- | --- |
| `generic-control-acceptance.test.ts` | Real portable Ask User, Prewalk, Tasks, and Context View adapters through the common client renderer, with hints absent; standalone unavailable behavior; no approval before the response. |
| `client-generic-integration.test.ts` | Production TUI creation options; real SessionClient, TUI controller, and ACP registry over FakeTransport; negotiated versus unsupported UI; canonical answers and item actions; disconnect/re-elicitation; submitted cancellation/action replay under the same request ID; rejection/indeterminate outcomes. |
| `client-ui.test.ts` | Generic field types, defaults, zero-field forms, query and item actions, paging, safe Markdown, read-only fallback, and TUI input mapping. |
| `acp-protocol-ui.test.ts` | Actual ACP elicitation schemas and controls, malformed answers, stale elements, disconnect cancellation, and read-only fallback. |
| `tui-generic-interactions.test.ts` | Revision fencing, recovery, disconnect, manual reopening, passive documents, and complete typed-status inspection. |
| `client-powerline.test.ts` | Optional footer derived from visible generic rows; no-hint fallback; multiple pages; recovery/removal; invalid decorations cannot supply hidden data. |
| `client-reducer.test.ts` | Presentation revision recovery and typed status updates. |

Focused command from the repository root:

```sh
scripts/test-isolated.sh pnpm --filter @felan-ai/felan exec vitest run test/generic-control-acceptance.test.ts test/client-generic-integration.test.ts test/client-ui.test.ts test/acp-protocol-ui.test.ts test/tui-generic-interactions.test.ts test/client-powerline.test.ts test/client-reducer.test.ts
```

Also run the changed workspace's build, type-check, and complete tests, then the repository's cross-package gate. A prepared test is not a passing result.

## Producer audit and kernel-dependent checks

The following producer families use the same client vocabulary. The client must never branch on their names or hints to authorize actions.

| Producer source | Required live check once the kernel is ready |
| --- | --- |
| `packages/ext-ask-user/src/ui.ts` | Wizard choice/freeform/comment/skip; invalid or missing answers never fabricate selections. |
| `packages/ext-prewalk/src/ui.ts` | Explicit entry, approve/feedback/cancel, and interrupted review without approval. |
| `packages/ext-tasks/src/portable-ui.ts` | Filter, paging, detail/back, create/update, read-only omission of mutation controls, stale revision rejection. |
| `packages/ext-background-bash/src/common-ui.ts` | Process list and output paging, exact stdin, stop/kill, close, and no success before the execution service settles. |
| `packages/ext-prompt-history/src/common-ui.ts` | Query/scope, detail and complete prompt paging, cancel-search/close; no automatic prompt submission. |
| `packages/ext-context-view/src/ui.ts` | Complete report and canonical close action, including shutdown cancellation. |
| `packages/ext-insights/src/sessions.ts` | Dashboard range, search, session paging and host-confirmed browser open through declared actions. |
| `packages/ext-powerline/src/generic.ts` | Generic view/status data in all modes; only the optional client footer uses `felan.powerline@2.0.0`. |

Fusion, memory and browser setup publish generic forms, documents and views.
Agent navigation uses scoped `executions.*` operations. Optional client hints
never authorize effects. Tools without a presentation surface need tool-result
checks, not invented UI controls.

Live acceptance must exercise the production provider composition and broker, not just FakeTransport: strip hints; inspect negotiated capabilities; repeat each mutating action across a lost reply; confirm a single effect; reject foreign/stale/closed IDs before effects; test reload and shutdown while requests are pending. Capture command output and failures. Run the complete cross-package gate with
`scripts/test-isolated.sh pnpm verify`.
