import { Type, type TOptional, type TString, type TBoolean, type TNumber } from 'typebox';
import { IdSchema, ThinkingSchema, enumOf, text } from './schema.js';
import { LIMITS } from './limits.js';

const strings = <const T extends readonly string[]>(values: T) => Object.fromEntries(values.map(key => [key, Type.Optional(text(LIMITS.structuredBytes))])) as { [K in T[number]]: TOptional<TString> };
const booleans = <const T extends readonly string[]>(values: T) => Object.fromEntries(values.map(key => [key, Type.Optional(Type.Boolean())])) as { [K in T[number]]: TOptional<TBoolean> };
const numbers = <const T extends readonly string[]>(values: T) => Object.fromEntries(values.map(key => [key, Type.Optional(Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))])) as { [K in T[number]]: TOptional<TNumber> };
const domainList = Type.Array(text(4096, 1), { maxItems: LIMITS.catalogEntries });
const segment = Type.Object({
  enabled: Type.Boolean(), align: Type.Optional(enumOf(['left', 'right'] as const)), style: Type.Optional(enumOf(['full', 'fish', 'basename'] as const)),
  type: Type.Optional(enumOf(['cost', 'tokens', 'both', 'breakdown'] as const)), displayStyle: Type.Optional(enumOf(['text', 'bar', 'blocks', 'blocks-line', 'dots'] as const)),
  ...booleans(['showSha', 'showWorkingTree', 'showTag', 'showTimeSinceCommit', 'showStashCount', 'showUpstream', 'showRepoName',
    'showPercentageOnly', 'showTokensOnly', 'showProviderName', 'showReset', 'showPercentage']),
  ...numbers(['maxWindows', 'periodDays', 'width', 'warningThreshold', 'criticalThreshold']),
}, { additionalProperties: false });
const segments = Type.Object(Object.fromEntries(['directory', 'git', 'model', 'session', 'subscription', 'savings', 'context', 'status', 'version']
  .map(name => [name, Type.Optional(segment)])), { additionalProperties: false });

export const ConfigValuesSchema = Type.Object({
  ...strings(['output-style', 'output-style-instructions', 'output-style-instructions-file',
    'ask-user-overlay-toggle-key', 'ask-user-comment-toggle-key', 'prewalk-target-model',
    'fusion-fusion-model', 'web-access-openai-search-model', 'web-access-searxng-base-url',
    'codebase-memory-auto-index-path']),
  ...booleans(['prewalk-restore-planner', 'codex-fast', 'codex-force-cached-web-sockets',
    'codex-post-agent-run-compaction', 'rtk-optimizer-enabled', 'rtk-optimizer-guard-when-rtk-missing',
    'rtk-optimizer-show-rewrite-notifications', 'rtk-optimizer-compaction-enabled', 'rtk-optimizer-strip-ansi',
    'rtk-optimizer-read-compaction', 'rtk-optimizer-truncate', 'rtk-optimizer-source-code-filtering-enabled',
    'rtk-optimizer-preserve-exact-skill-reads', 'rtk-optimizer-smart-truncate', 'rtk-optimizer-aggregate-test-output',
    'rtk-optimizer-filter-build-output', 'rtk-optimizer-compact-git-output', 'rtk-optimizer-aggregate-linter-output',
    'rtk-optimizer-group-search-output', 'rtk-optimizer-track-savings', 'powerline-auto-wrap']),
  ...numbers(['fusion-concurrency', 'fusion-timeout-seconds', 'fusion-max-output-chars',
    'background-bash-foreground-timeout-seconds', 'rtk-optimizer-truncate-max-chars',
    'rtk-optimizer-smart-truncate-max-lines', 'codebase-memory-max-cache-bytes', 'powerline-padding']),
  'ask-user-display-mode': Type.Optional(enumOf(['overlay', 'inline'] as const)),
  'ask-user-single-select-layout': Type.Optional(enumOf(['auto', 'list'] as const)),
  'tasks-display-mode': Type.Optional(enumOf(['overlay', 'inline'] as const)),
  'prompt-history-display-mode': Type.Optional(enumOf(['overlay', 'inline'] as const)),
  'prewalk-target-thinking': Type.Optional(enumOf(['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const)),
  'prewalk-entry-approval': Type.Optional(enumOf(['ask', 'allow', 'deny'] as const)),
  'prewalk-plan-review': Type.Optional(enumOf(['inherit', 'ask', 'skip'] as const)),
  'fusion-participants': Type.Optional(Type.Array(IdSchema, { maxItems: 8, uniqueItems: true })),
  'fusion-thinking': Type.Optional(ThinkingSchema),
  'web-access-provider': Type.Optional(Type.Union([text(128, 1), Type.Array(text(128, 1), { maxItems: 4 })])),
  'web-access-search-provider': Type.Optional(Type.Union([Type.Null(), text(128, 1), Type.Array(text(128, 1), { maxItems: 4 })])),
  'web-access-pdf': Type.Optional(Type.Object({ maxSizeMB: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 20 })) }, { additionalProperties: false })),
  'web-access-fetch-content': Type.Optional(Type.Object({ domainPolicy: Type.Optional(Type.Object({ allow: Type.Optional(domainList), deny: Type.Optional(domainList) }, { additionalProperties: false })) }, { additionalProperties: false })),
  'web-access-ssrf': Type.Optional(Type.Object({ allowRanges: Type.Optional(domainList) }, { additionalProperties: false })),
  'browser-authorization-policy': Type.Optional(enumOf(['ask', 'always-allow'] as const)),
  'codex-priority': Type.Optional(enumOf(['normal', 'fast', 'ultrafast'] as const)),
  'codex-verbosity': Type.Optional(enumOf(['low', 'medium', 'high'] as const)),
  'session-compaction-method': Type.Optional(enumOf(['summary', 'classifier'] as const)),
  'session-compaction-model': Type.Optional(enumOf(['inherit', 'xhigh', 'high', 'medium', 'low'] as const)),
  'rtk-optimizer-mode': Type.Optional(enumOf(['rewrite', 'suggest'] as const)),
  'rtk-optimizer-source-filtering': Type.Optional(enumOf(['none', 'minimal', 'aggressive'] as const)),
  'codebase-memory-mode': Type.Optional(enumOf(['curated', 'direct', 'proxy'] as const)),
  'powerline-style': Type.Optional(enumOf(['minimal', 'powerline', 'capsule'] as const)),
  'powerline-charset': Type.Optional(enumOf(['text', 'unicode'] as const)),
  'powerline-lines': Type.Optional(Type.Array(Type.Object({ segments }, { additionalProperties: false }), { maxItems: 16 })),
  scopedModels: Type.Optional(Type.Array(IdSchema, { maxItems: LIMITS.catalogEntries, uniqueItems: true })),
  defaultModel: Type.Optional(IdSchema),
  defaultThinking: Type.Optional(ThinkingSchema),
  classifierModel: Type.Optional(IdSchema),
  builtinExtensions: Type.Optional(Type.Record(Type.String({ pattern: `^[A-Za-z][A-Za-z0-9_-]{0,${LIMITS.idBytes - 1}}$` }), Type.Boolean(), { additionalProperties: false, maxProperties: LIMITS.catalogEntries })),
}, { additionalProperties: false, 'x-maxEncodedBytes': LIMITS.structuredBytes });

export const ConfigScopeSchema = enumOf(['session', 'project', 'global'] as const);
