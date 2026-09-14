import { describe, expect, it } from 'vitest';
import { ASK_USER_CONFIG } from '@felan-ai/ext-ask-user';
import { CODEBASE_MEMORY_CONFIG } from '@felan-ai/ext-codebase-memory';
import { CODEX_CONFIG } from '@felan-ai/ext-codex';
import { CONTEXT_VIEW_CONFIG } from '@felan-ai/ext-context-view';
import { OUTPUT_STYLE_CONFIG } from '@felan-ai/ext-output-style';
import { POWERLINE_CONFIG } from '@felan-ai/ext-powerline';
import { PREWALK_CONFIG } from '@felan-ai/ext-prewalk';
import { PROMPT_HISTORY_CONFIG } from '@felan-ai/ext-prompt-history';
import { RTK_OPTIMIZER_CONFIG } from '@felan-ai/ext-rtk-optimizer';
import { TASKS_CONFIG } from '@felan-ai/ext-tasks';
import { WEB_ACCESS_CONFIG } from '@felan-ai/ext-web-access';

const DEFINITIONS = [
  ['ext-ask-user', ASK_USER_CONFIG],
  ['ext-codebase-memory', CODEBASE_MEMORY_CONFIG],
  ['ext-codex', CODEX_CONFIG],
  ['ext-context-view', CONTEXT_VIEW_CONFIG],
  ['ext-output-style', OUTPUT_STYLE_CONFIG],
  ['ext-powerline', POWERLINE_CONFIG],
  ['ext-prewalk', PREWALK_CONFIG],
  ['ext-prompt-history', PROMPT_HISTORY_CONFIG],
  ['ext-rtk-optimizer', RTK_OPTIMIZER_CONFIG],
  ['ext-tasks', TASKS_CONFIG],
  ['ext-web-access', WEB_ACCESS_CONFIG],
];

// The mechanical rule, recomputed from attributes already on each field.
function expectedScope(field) {
  if (field.sensitive === true) return 'session';
  if (field.type === 'json') return 'project';
  return 'user';
}

describe('extension config scope classification', () => {
  for (const [pkg, definition] of DEFINITIONS) {
    it(`${pkg}: every field follows the mechanical rule`, () => {
      const entries = Object.entries(definition.fields);
      expect(entries.length).toBeGreaterThan(0);
      for (const [name, field] of entries) {
        expect(`${pkg}.${name} -> ${field.scope}`)
          .toBe(`${pkg}.${name} -> ${expectedScope(field)}`);
      }
    });
  }

  it('web-access sensitive fields are session-scoped', () => {
    for (const name of ['openaiApiKey', 'exaApiKey', 'braveApiKey', 'searxngHeaders']) {
      expect(WEB_ACCESS_CONFIG.fields[name].scope).toBe('session');
    }
  });

  it('web-access json policy fields are project-scoped', () => {
    for (const name of ['provider', 'searchProvider', 'pdf', 'githubClone', 'fetchContent', 'ssrf']) {
      expect(WEB_ACCESS_CONFIG.fields[name].scope).toBe('project');
    }
  });

  it('powerline.lines is project-scoped, its scalars are user-scoped', () => {
    expect(POWERLINE_CONFIG.fields.lines.scope).toBe('project');
    for (const name of ['style', 'charset', 'autoWrap', 'padding']) {
      expect(POWERLINE_CONFIG.fields[name].scope).toBe('user');
    }
  });

  it('every rtk-optimizer knob is user-scoped', () => {
    for (const field of Object.values(RTK_OPTIMIZER_CONFIG.fields)) {
      expect(field.scope).toBe('user');
    }
  });
});
