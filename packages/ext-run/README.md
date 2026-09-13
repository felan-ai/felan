# @felan-ai/ext-run

Portable, bounded code mode for composing active Felan tools in one model tool
call. `run_code` evaluates JavaScript or type-stripped TypeScript in a fresh
QuickJS worker supplied by `run` 2.1.4:

```ts
const [files, docs] = await Promise.all([
  tools.search_code({ pattern: 'registerTool', path: 'packages' }),
  tools.web_search({ query: 'QuickJS sandbox' }),
]);
return { files, docs };
```

Each call includes a short `title` describing the overall operation. Felan
renders it as `Run Code - <title>` in full tool mode and as the action preview
in grouped mode.

The guest has no Node.js, filesystem, module, environment, or network access.
It reaches the host only through `tools.<name>(input)`. Nested calls use Agent
Core's active-tool dispatcher, so normal validation, authorization hooks,
cancellation, and result policy still apply.

## Access policy

By default, the extension exposes `read`, `grep`, `find`, `ls`,
`read_symbol`, `search_and_read_symbols`, `search_code`, `session_recall`,
`TaskList`, `TaskGet`, `web_search`, and `fetch_content` when active. Configure
an exact replacement list with `extensionConfig.run.toolNames`; inactive tools
are never exposed. `run_code`, `enter_prewalk`, `enter_plan_mode`, and
`exit_plan_mode` are always excluded. Opted-in side effects are not transactional
and may partially finish.

Normal results crossing into the guest and the final guest result are bounded
and text-only; images are rejected. A nested `terminate: true` aborts the worker
and returns that tool's termination content with outer `terminate: true`, even
if guest code catches host errors. Termination content remains subject to the
same text-only and final-output byte limits; invalid content becomes a bounded
terminating error. At most 1,024 normalized text blocks are accepted. The outer
result also preserves a terminating tool's error flag through the `tool_result`
hook. Code mode does not provide Run continuations or rollback, and its worker
is not an OS/container isolation boundary. Keep untrusted projects in an
isolated host runtime.

Direct tools remain available for one-off calls, interactive actions, images,
mutations, and lifecycle controls.

## Host-only audit

Each nested call, including explicitly configured side effects, is recorded in
the outer result's host-only `details.calls`, not in model-visible content or
guest output. Entries contain the tool name, nested `toolCallId` when available,
a serialized arguments summary, `isError`, `terminate`, and an outcome or failure
summary. Caught failures remain recorded. If execution throws, a pending result
patch keyed by the outer `toolCallId` restores the audit through `tool_result`
and is then discarded; session start and shutdown clear unconsumed patches.

Audit strings have terminal/control sequences stripped. Argument keys matching
credential, secret, token, password, cookie, authorization, private-key, API-key,
or access-key forms are redacted case-insensitively, including nested objects
and arrays. This is key-based redaction, not secret detection in arbitrary text;
avoid secrets in free-form arguments and tool output.

The audit retains at most 256 entries and 64 KiB of serialized details. Names
are capped at 128 UTF-8 bytes, IDs at 256 bytes, and each arguments/outcome
summary at 2 KiB. Argument traversal is limited to 16 object/array levels.
`callsTruncated` flags omitted entries, clipped summaries, serialization/depth
limits, or calls whose outcomes were still unknown when execution ended.
Rich binary and collection values use lossy type/size summaries and mark the
audit truncated; sanitized key collisions also drop the later value and mark
truncation. Clipped argument summaries need not remain valid JSON. An audit does
not imply rollback or prove that an interrupted side effect did not complete.

## Development

```sh
pnpm --filter @felan-ai/ext-run build
pnpm --filter @felan-ai/ext-run type-check
pnpm --filter @felan-ai/ext-run test
```
