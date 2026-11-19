import { describe, expect, it } from 'vitest';
import {
  KNOWN_CHANGE_TYPES, PUBLISHED_CHANGE_TYPES, PUBLISHED_TASK_TEXT_BYTES, PUBLISHED_TOOL_OUTPUT_CHARACTERS, PUBLICATION_LIMITS,
  parsePublishedEvent, parsePublishedSession, type KnownSessionChange,
} from '@felan-ai/session-protocol';
import { publishableChange, publishedEvent, publishedSession, publishedTaskDetails } from '../src/remote/content.js';

const session = '01999999-1111-7111-8111-111111111111';
const message = (text: string): KnownSessionChange => ({ type: 'message.completed', message: { id: 'm', entryId: 'e', role: 'assistant', timestamp: 1, content: [{ type: 'text', text }] } });
const interaction = { id: 'i', scope: { kind: 'session' as const, session, root: session }, request: { kind: 'confirm' as const, title: 'Confirm', message: 'Yes?' }, state: 'waiting' as const, createdAt: 1, authority: 'local-console' as const };
const changes: KnownSessionChange[] = [
  message('Hello'),
  { type: 'tool.updated', tool: { id: 't', message: 'm', name: 'bash', state: 'completed', output: 'ok', truncated: false } },
  { type: 'run.updated', run: { state: 'idle' } },
  { type: 'queue.updated', queue: [{ id: 'q', kind: 'steer', prompt: { text: 'Next' }, origin: { kind: 'tui', attachment: 'a' } }] },
  { type: 'interaction.requested', interaction },
  { type: 'interaction.resolved', interaction: { ...interaction, state: 'cancelled', resolvedAt: 2, result: { cancelled: true, reason: 'user' } } },
  { type: 'metadata.updated', title: 'Title', state: 'open', residency: 'warm' },
  { type: 'model.updated', model: { id: 'test', provider: 'test' }, thinking: 'off' },
  { type: 'child.updated', child: { session, parent: session, root: session, title: 'Child', run: { state: 'idle' }, state: 'open' } },
  { type: 'stream.completion_only', stream: { message: 'm', id: 'stream', kind: 'assistant', reason: 'lost' } },
];

describe('remote publication content', () => {
  for (const type of KNOWN_CHANGE_TYPES) {
    it(`applies the publish set to ${type}`, () => {
      const fixture = changes.find(change => change.type === type);
      const change = publishableChange(fixture ?? { type } as KnownSessionChange);
      if (PUBLISHED_CHANGE_TYPES.includes(type as typeof PUBLISHED_CHANGE_TYPES[number])) {
        expect(change?.type).toBe(type);
        const event = publishedEvent(session, { seq: 1, rev: 5000, occurredAt: 10, change: change! });
        expect(parsePublishedEvent(event)).toEqual(event);
      } else expect(change).toBeUndefined();
    });
  }
  it('caps tool output in Unicode code points and sets truncated without mutating the input', () => {
    const output = '🦊'.repeat(5000);
    const original: KnownSessionChange = { type: 'tool.updated', tool: { id: 'tool', message: 'm', name: 'bash', state: 'completed', output, truncated: false } };
    const change = publishableChange(original)!;
    expect(change.type).toBe('tool.updated');
    if (change.type !== 'tool.updated') return;
    expect(Array.from(change.tool.output)).toHaveLength(PUBLISHED_TOOL_OUTPUT_CHARACTERS); expect(change.tool.truncated).toBe(true);
    expect(original.tool.output).toBe(output); expect(original.tool.truncated).toBe(false);
    expect(parsePublishedEvent(publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change })).change).toEqual(change);
  });
  it('preserves already-truncated output and does not set truncated for short output', () => {
    for (const truncated of [false, true]) {
      const change = publishableChange({ type: 'tool.updated', tool: { id: 't', message: 'm', name: 'bash', state: 'completed', output: 'short', truncated } });
      expect(change).toMatchObject({ tool: { output: 'short', truncated } });
    }
  });
  it('replaces NUL in tool output, identities and object keys before applying publication limits', () => {
    const id = `t${'\0'.repeat(127)}`;
    const original: KnownSessionChange = { type: 'tool.updated', tool: {
      id, message: id, name: 'bash\0', state: 'completed', output: '\0'.repeat(5000), truncated: false,
      details: { 'key\0': ['value\0', { '\0nested': '\0' }] },
    } };
    const change = publishableChange(original)!;
    const event = publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change });
    expect(JSON.stringify(event).includes('\\u0000')).toBe(false);
    expect(change).toMatchObject({ tool: {
      id: `t${'\uFFFD'.repeat(42)}`, message: `t${'\uFFFD'.repeat(42)}`, name: 'bash\uFFFD',
      output: '\uFFFD'.repeat(PUBLISHED_TOOL_OUTPUT_CHARACTERS), truncated: true,
      details: { 'key\uFFFD': ['value\uFFFD', { '\uFFFDnested': '\uFFFD' }] },
    } });
    expect(Buffer.byteLength(JSON.stringify(change))).toBeLessThanOrEqual(PUBLICATION_LIMITS.changeBytes);
    expect(original.tool.output).toBe('\0'.repeat(5000)); expect(original.tool.id).toBe(id);
  });
  it('replaces NUL throughout completed messages and fits their encoded byte budget', () => {
    const original: KnownSessionChange = { type: 'message.completed', message: {
      id: 'm\0', entryId: 'e\0', role: 'assistant', timestamp: 1, content: [
        { type: 'text', text: '\0'.repeat(400_000) }, { type: 'thinking', text: 'thought\0' },
        { type: 'tool_call', id: 't\0', name: 'tool\0', arguments: { 'key\0': ['argument\0'] } },
        { type: 'tool_result', id: 't\0', text: 'result\0', isError: false, details: { 'key\0': 'detail\0' } },
      ], details: { 'key\0': 'detail\0' },
    } };
    const change = publishableChange(original)!;
    const event = publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change });
    expect(JSON.stringify(event).includes('\\u0000')).toBe(false);
    expect(change).toMatchObject({ message: { id: 'm\uFFFD', entryId: 'e\uFFFD', details: { 'key\uFFFD': 'detail\uFFFD' } } });
    expect(JSON.stringify(change)).toContain('thought\uFFFD'); expect(JSON.stringify(change)).toContain('argument\uFFFD');
    expect(JSON.stringify(change)).toContain('result\uFFFD');
    expect(Buffer.byteLength(JSON.stringify(change))).toBeLessThanOrEqual(PUBLICATION_LIMITS.changeBytes);
    expect(original.message.content[0]).toEqual({ type: 'text', text: '\0'.repeat(400_000) });
  });
  it('redacts provider keys, PATs, JWTs and Bearer headers in text, thinking, results and nested argument leaves', () => {
    const secrets = ['sk-secret123456789', 'fln_pat_test123456789', 'bzy_team_test123456789', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature', 'Bearer abc123456789'];
    const text = secrets.join(' ');
    const change = publishableChange({ type: 'message.completed', message: {
      id: 'm', entryId: 'e', role: 'assistant', timestamp: 1,
      content: [
        { type: 'text', text }, { type: 'thinking', text }, { type: 'tool_result', id: 't', text, isError: false, details: { response: text } },
        { type: 'tool_call', id: 't', name: 'tool', arguments: { nested: [text, { token: 'short-secret' }] } },
      ], details: { description: text },
    } })!;
    const bytes = JSON.stringify(change);
    for (const secret of [...secrets, 'short-secret']) expect(bytes).not.toContain(secret);
    expect(bytes).toContain('[redacted]');
    expect(parsePublishedEvent(publishedEvent(session, { seq: 1, rev: 1, occurredAt: 0, change })).change).toEqual(change);
  });
  it('redacts tool output, interaction summaries, queue prompts and child titles', () => {
    const secret = 'fln_pat_abcdefghijk';
    const inputs: KnownSessionChange[] = [
      { type: 'tool.updated', tool: { id: 't', message: 'm', name: 'bash', state: 'completed', output: secret, truncated: false } },
      { type: 'interaction.requested', interaction: { ...interaction, request: { kind: 'tool_approval', toolCallId: 't', toolName: 'bash', summary: secret, options: [{ id: 'yes', title: secret }] } } },
      { type: 'queue.updated', queue: [{ id: 'q', kind: 'follow_up', prompt: { text: secret }, origin: { kind: 'headless', attachment: 'a' } }] },
      { type: 'child.updated', child: { session, parent: session, root: session, title: secret, run: { state: 'idle' }, state: 'open' } },
      { type: 'metadata.updated', title: secret, state: 'open', residency: 'warm' },
    ];
    for (const input of inputs) {
      const change = publishableChange(input)!; expect(JSON.stringify(change)).not.toContain(secret);
      expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change })).not.toThrow();
    }
  });
  it('replaces inline images in messages and queued attachments with text placeholders', () => {
    const input = { type: 'image' as const, mimeType: 'image/png' as const, data: 'a'.repeat(2 * 1024 * 1024) };
    const a = publishableChange({ type: 'message.completed', message: { id: 'm', entryId: 'e', role: 'user', timestamp: 0, content: [input] } })!;
    const b = publishableChange({ type: 'queue.updated', queue: [{ id: 'q', kind: 'steer', prompt: { text: '', attachments: [input] }, origin: { kind: 'tui', attachment: 'a' } }] })!;
    for (const change of [a, b]) {
      expect(JSON.stringify(change)).toContain('[image omitted]'); expect(JSON.stringify(change)).not.toContain('"data"');
      expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change })).not.toThrow();
    }
  });
  it('deterministically fits escaped multibyte text and nested arguments to the 1 MiB JSON budget', () => {
    const input = message('🦊\n"'.repeat(200_000));
    if (input.type === 'message.completed') input.message.content.push({ type: 'tool_call', id: 't', name: 'test', arguments: { text: '日本語'.repeat(180_000) } });
    const first = publishableChange(input)!; const second = publishableChange(input)!;
    expect(first).toEqual(second); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(PUBLICATION_LIMITS.changeBytes);
    expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 1, change: first })).not.toThrow();
  });
  it('bounds redacted session title/directory in UTF-8 and maps every run state', () => {
    for (const state of ['idle', 'running', 'waiting', 'cancelling', 'interrupted'] as const) {
      const value = publishedSession({ session, parent: session, cwd: `/private/full/path/${'🦊'.repeat(100)}`, title: `fln_pat_secret123 ${'日'.repeat(1000)}`, state: 'closed', run: { state }, shared: false });
      expect(value.runState).toBe(state); expect(value.state).toBe('closed'); expect(value.parent).toBe(session);
      expect(Buffer.byteLength(value.directory)).toBeLessThanOrEqual(256); expect(Buffer.byteLength(value.title)).toBeLessThanOrEqual(1024);
      expect(value.directory).not.toContain('/private'); expect(value.title).not.toContain('fln_pat_'); expect(value.title).not.toContain('�');
      expect(parsePublishedSession(value)).toEqual(value);
    }
  });
  it('replaces NUL throughout session rows and bounds the replacement text in UTF-8', () => {
    const value = publishedSession({
      session, cwd: `/work/${'\0'.repeat(300)}`, title: `Title\0${'\0'.repeat(1024)}`, state: 'open', run: { state: 'idle' }, shared: true,
      skills: [{ name: 'skill\0', description: '\0'.repeat(1024), filePath: `/work/${'\0'.repeat(600)}/SKILL.md`, scope: 'project' }],
      processes: [{ id: '\0'.repeat(128), session, root: session, kind: 'detached', state: 'running', command: '\0'.repeat(1024), startedAt: 0,
        controllable: true, outputOffset: 0 }],
    });
    expect(JSON.stringify(value)).not.toContain('\\u0000'); expect(value.title).toMatch(/^Title\uFFFD/u);
    expect(Buffer.byteLength(value.title)).toBeLessThanOrEqual(1024); expect(Buffer.byteLength(value.directory)).toBeLessThanOrEqual(256);
    expect(value.skills?.[0]?.name).toBe('skill\uFFFD');
    expect(Buffer.byteLength(value.skills![0]!.description)).toBeLessThanOrEqual(1024); expect(Buffer.byteLength(value.skills![0]!.path)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(value.processes![0]!.id)).toBeLessThanOrEqual(128); expect(Buffer.byteLength(value.processes![0]!.command)).toBeLessThanOrEqual(1024);
    expect(parsePublishedSession(value)).toEqual(value);
  });
  it('publishes loaded skills with project- or home-relative paths and redacted descriptions', () => {
    const base = { session, cwd: '/home/agent/work/felan', title: 'T', state: 'open' as const, run: { state: 'idle' as const }, shared: true, home: '/home/agent' };
    const value = publishedSession({ ...base, skills: [
      { name: 'felan', description: 'Delegate work.', filePath: '/home/agent/work/felan/.agents/skills/felan/SKILL.md', scope: 'project' },
      { name: 'linear', description: 'Use LINEAR_API_KEY=lin_api_secret123 here.', filePath: '/home/agent/.agents/skills/linear/SKILL.md', scope: 'user' },
      { name: 'scratch', description: '日'.repeat(1000), filePath: '/tmp/run-1/skills/scratch/SKILL.md', scope: 'temporary' },
      { name: 'sibling', description: '', filePath: '/home/agent/work/felan-other/SKILL.md', scope: 'user' },
    ] });
    expect(value.skills?.map(skill => skill.path)).toEqual(['.agents/skills/felan/SKILL.md', '~/.agents/skills/linear/SKILL.md', 'scratch/SKILL.md', '~/work/felan-other/SKILL.md']);
    expect(value.skills?.map(skill => skill.scope)).toEqual(['project', 'user', 'temporary', 'user']);
    expect(value.skills?.[1]?.description).not.toContain('lin_api_secret123');
    expect(Buffer.byteLength(value.skills![2]!.description)).toBeLessThanOrEqual(1024); expect(value.skills![2]!.description).not.toContain('�');
    expect(JSON.stringify(value.skills)).not.toContain('/home/agent');
    const many = Array.from({ length: 300 }, (_, index) => ({ name: `s${index}`, description: '', filePath: `/home/agent/s${index}/SKILL.md`, scope: 'user' as const }));
    expect(publishedSession({ ...base, skills: many }).skills).toHaveLength(256);
    expect(publishedSession(base)).not.toHaveProperty('skills');
  });
  it('publishes only this session\'s processes, running first, with redacted commands and known exit codes', () => {
    const base = { session, cwd: '/w', title: 'T', state: 'open' as const, run: { state: 'idle' as const }, shared: true };
    const other = '01999999-2222-7222-8222-222222222222';
    const process = (id: string, state: 'running' | 'exited' | 'missing' | 'interrupted', startedAt: number, extra: { exitCode?: number; session?: string; command?: string } = {}) => ({
      id, session: extra.session ?? session, root: session, kind: 'detached' as const, state, command: extra.command ?? `run ${id}`, startedAt,
      controllable: state === 'running', outputOffset: 99, ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
    });
    const value = publishedSession({ ...base, processes: [
      process('old', 'exited', 1, { exitCode: 2 }), process('lost', 'missing', 3), process('live', 'running', 2, { command: `curl -H 'Authorization: Bearer abc.def' ${'x'.repeat(2000)}` }),
      process('child', 'running', 4, { session: other }), process('gone', 'interrupted', 5),
    ] });
    expect(value.processes?.map(item => item.id)).toEqual(['live', 'gone', 'lost', 'old']);
    expect(value.processes?.[3]).toEqual({ id: 'old', command: 'run old', kind: 'detached', state: 'exited', startedAt: 1, exitCode: 2 });
    expect(value.processes?.[2]).not.toHaveProperty('exitCode');
    expect(value.processes?.[0]?.command).not.toContain('abc.def'); expect(Buffer.byteLength(value.processes![0]!.command)).toBeLessThanOrEqual(1024);
    expect(publishedSession({ ...base, processes: Array.from({ length: 300 }, (_, index) => process(`p${index}`, 'exited', index)) }).processes).toHaveLength(256);
    expect(publishedSession({ ...base, processes: [] }).processes).toEqual([]);
    expect(publishedSession(base)).not.toHaveProperty('processes');
  });
  it('publishes bounded task metadata and keeps long task text out of the row', () => {
    const task = {
      id: 'T-ABC123', title: 'a'.repeat(194) + '?key=x', status: 'in_progress' as const, blockedBy: [], priority: 0, ownerSessionId: session,
      createdAt: '1970-01-01T00:00:00Z', updatedAt: '2026-11-18T12:01:00Z', claimedAt: '2026-11-18T12:00:00Z',
      description: 'private description', acceptanceCriteria: 'private criteria', notes: 'private notes', result: 'private result', blockedReason: 'private blocker',
    };
    const completed = { id: 'T-DEF456', title: 'Done', status: 'completed' as const, blockedBy: [], priority: 4, completedAt: '2026-11-18T12:02:00Z' };
    const invalid = { id: 'T-GHI789', title: 'Invalid metadata', status: 'pending' as const, blockedBy: [], priority: 1.5, ownerSessionId: '',
      createdAt: 'invalid', updatedAt: '1969-12-31T23:59:59.999Z', claimedAt: '+300000-01-01T00:00:00Z', completedAt: '' };
    const base = { session, cwd: '/w', title: 'T', state: 'open' as const, run: { state: 'idle' as const }, shared: true };
    const value = publishedSession({ ...base, tasks: [task, completed, invalid] });
    expect(value.tasks).toEqual([
      { id: task.id, title: 'a'.repeat(194) + '?key=[', status: 'in_progress', blockedBy: [], priority: 0, ownerSessionId: session,
        createdAt: 0, updatedAt: Date.parse(task.updatedAt), claimedAt: Date.parse(task.claimedAt) },
      { id: completed.id, title: completed.title, status: 'completed', blockedBy: [], priority: 4, completedAt: Date.parse(completed.completedAt) },
      { id: invalid.id, title: invalid.title, status: 'pending', blockedBy: [] },
    ]);
    expect(JSON.stringify(value.tasks)).not.toContain('private');
    expect(parsePublishedSession(value)).toEqual(value);
    expect(publishedSession({ ...base, tasks: [] }).tasks).toEqual([]);
    expect(publishedSession({ ...base, shared: false, tasks: [task] })).not.toHaveProperty('tasks');
    expect(publishedSession(base)).not.toHaveProperty('tasks');
    expect(publishableChange({ type: 'tasks.updated' })).toBeUndefined();
  });
  it.each([-1, 5, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('omits invalid task priority %s', priority => {
    const value = publishedSession({ session, cwd: '/w', title: 'T', state: 'open', run: { state: 'idle' }, shared: true,
      tasks: [{ id: 'T-ABC123', title: 'Task', status: 'pending', blockedBy: [], priority }] });
    expect(value.tasks?.[0]).not.toHaveProperty('priority');
  });
  it('caps session task summaries at 256 tasks and 32 blockers', () => {
    const blockedBy = Array.from({ length: 40 }, (_, index) => `T-B${index}`);
    const tasks = Array.from({ length: 300 }, (_, index) => ({ id: `T-${index}`, title: 'Task', status: 'pending' as const, blockedBy }));
    const value = publishedSession({ session, cwd: '/w', title: 'T', state: 'open', run: { state: 'idle' }, shared: true, tasks });
    expect(value.tasks).toHaveLength(256); expect(value.tasks?.[255]?.id).toBe('T-255');
    expect(value.tasks?.[0]?.blockedBy).toEqual(blockedBy.slice(0, 32)); expect(blockedBy).toHaveLength(40);
  });
  it('redacts task detail credentials without changing task identities or publishing summary fields', () => {
    const task = { id: 'sk-task123456789', title: 'Task', status: 'blocked' as const, blockedBy: [], priority: 1,
      description: 'Use fln_pat_test123456789', acceptanceCriteria: 'api_key=short-secret', notes: 'Bearer abc123456789',
      result: 'sk-secret123456789', blockedReason: 'Blocked\0by github_pat_test123456789' };
    expect(publishedTaskDetails([task])).toEqual([{ id: task.id,
      description: 'Use [redacted]', acceptanceCriteria: 'api_key=[redacted]', notes: 'Bearer [redacted]',
      result: '[redacted]', blockedReason: 'Blocked\uFFFDby [redacted]',
    }]);
    expect(task.description).toBe('Use fln_pat_test123456789');
  });
  it.each(Object.entries(PUBLISHED_TASK_TEXT_BYTES))('cuts task detail %s only past %i UTF-8 bytes', (field, bytes) => {
    const task = { id: 'T-ABC123', title: 'Task', status: 'pending' as const, blockedBy: [] };
    for (const character of ['x', '😀']) {
      const count = bytes / Buffer.byteLength(character);
      expect(publishedTaskDetails([{ ...task, [field]: character.repeat(count) }])).toEqual([{ id: task.id, [field]: character.repeat(count) }]);
      expect(publishedTaskDetails([{ ...task, [field]: character.repeat(count + 1) }])).toEqual([{ id: task.id, [field]: character.repeat(count) }]);
    }
  });
  it('replaces ill-formed Unicode in task titles and details instead of failing', () => {
    const task = { id: 'T-ABC123', title: 'Lone \uD800 title', status: 'pending' as const, blockedBy: [], notes: 'Lone \uDC00 note' };
    expect(publishedTaskDetails([task])).toEqual([{ id: task.id, notes: 'Lone \uFFFD note' }]);
    const base = { session, cwd: '/w', title: 'T', state: 'open' as const, run: { state: 'idle' as const }, shared: true };
    expect(publishedSession({ ...base, tasks: [task] }).tasks?.[0]?.title).toBe('Lone \uFFFD title');
  });
  it('omits absent and empty task detail fields and keeps id-only records', () => {
    const task = { id: 'T-ABC123', title: 'Task', status: 'pending' as const, blockedBy: [] };
    expect(publishedTaskDetails([task, { ...task, id: 'T-DEF456', description: '', acceptanceCriteria: '', notes: '', result: '', blockedReason: '' }]))
      .toEqual([{ id: task.id }, { id: 'T-DEF456' }]);
    expect(publishedTaskDetails([])).toEqual([]);
  });
  it('caps task details at the first 256 tasks', () => {
    const tasks = Array.from({ length: 300 }, (_, index) => ({ id: `T-${index}`, title: 'Task', status: 'pending' as const, blockedBy: [], notes: `Notes ${index}` }));
    const details = publishedTaskDetails(tasks);
    expect(details).toHaveLength(256); expect(details.map(task => task.id)).toEqual(tasks.slice(0, 256).map(task => task.id));
    expect(details[255]).toEqual({ id: 'T-255', notes: 'Notes 255' });
  });
  it('publishes channel origins with their provider and identities intact', () => {
    const origin = { kind: 'channel' as const, provider: 'slack', user: session, command: session };
    const change: KnownSessionChange = { type: 'run.updated', run: { state: 'running', id: 'run', origin } };
    expect(publishableChange(change)).toEqual(change);
  });

  it('preserves interaction identities while redacting their visible labels', () => {
    const id = 'sk-choice123456789';
    const change = publishableChange({ type: 'interaction.resolved', interaction: {
      ...interaction, request: { kind: 'select', title: 'Select', multiple: false, choices: [{ id, title: 'fln_pat_label123456789' }] },
      state: 'answered', responder: 'r', resolvedAt: 2, result: { kind: 'select', choices: [id] },
    } })!;
    expect(change).toMatchObject({ interaction: { result: { choices: [id] }, request: { choices: [{ id, title: '[redacted]' }] } } });
    expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 2, change })).not.toThrow();
  });
  it('fails closed when non-text structure cannot fit without dropping records', () => {
    const change = message('text');
    if (change.type !== 'message.completed') return;
    change.message.details = Array.from({ length: 600_000 }, () => 0);
    expect(() => publishableChange(change)).toThrow(/non-text structure/u);
  });
  it('rejects malformed and oversize publication entries at the boundary', () => {
    const change = publishableChange(message('ok'))!;
    expect(() => publishedEvent('../bad', { seq: 1, rev: 1, occurredAt: 0, change })).toThrow();
    expect(() => publishedEvent(session, { seq: 0, rev: 1, occurredAt: 0, change })).toThrow();
    expect(() => publishedEvent(session, { seq: 1, rev: 1, occurredAt: 0, change: message('x'.repeat(2 * 1024 * 1024)) as typeof change })).toThrow(/byte limit/u);
  });
});
