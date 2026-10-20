import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseApprovalExemptTools } from '../../src/providers/tool-policy.js';

describe('configured tool approval exemptions', () => {
  it('preserves the packaged approval policy', () => {
    const config = JSON.parse(readFileSync(new URL('../../src/host.json', import.meta.url), 'utf8')) as {
      services: Array<{ id: string; options?: unknown }>;
    };
    expect(parseApprovalExemptTools(config.services.find(service => service.id === 'felan.session-runtime')?.options)).toEqual([
      'TaskGet', 'TaskList', 'ask_user', 'codebase_memory', 'enter_prewalk', 'exit_plan_mode',
      'find', 'get_subagent_result', 'grep', 'list_background_bash', 'list_subagents', 'ls',
      'read', 'read_background_bash', 'read_symbol', 'search_and_read_symbols', 'search_code',
      'session_recall', 'wait_background_bash',
    ]);
  });

  it('copies configured exemptions and defaults to requiring approval', () => {
    expect(parseApprovalExemptTools(undefined)).toEqual([]);
    expect(parseApprovalExemptTools({})).toEqual([]);
    const names = ['inspect', 'inspect'];
    const parsed = parseApprovalExemptTools({ approvalExemptTools: names });
    names.push('write');
    expect(parsed).toEqual(['inspect']);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects malformed and unbounded policy values', () => {
    for (const options of [null, [], 'read', { approvalExemptTools: 'read' }, { approvalExemptTools: [1] },
      { approvalExemptTools: [''] }, { approvalExemptTools: ['x'.repeat(129)] }, { approvalExemptTools: Array(257).fill('read') }]) {
      expect(() => parseApprovalExemptTools(options)).toThrow();
    }
  });
});
