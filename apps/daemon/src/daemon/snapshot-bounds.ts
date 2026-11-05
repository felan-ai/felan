import { LIMITS, type SessionSnapshot } from '@felan-ai/session-protocol';

// Reserve half the client state cap for live updates and the attach response envelope.
export const SNAPSHOT_BYTE_BUDGET = LIMITS.pageBytes / 2;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Uses the same branch-relative cutover as SessionProjection.history. */
export function encodeHistoryCursor(session: string, revision: number, branch: string, endIndex: number): string {
  return Buffer.from(JSON.stringify([session, revision, branch, endIndex])).toString('base64url');
}

/** Live state may exceed the target budget so attachment can still succeed. */
export function boundSnapshot(snapshot: SessionSnapshot, budget = SNAPSHOT_BYTE_BUDGET): SessionSnapshot {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new RangeError('Invalid snapshot byte budget.');
  let size = bytes(snapshot);
  if (size <= budget) return snapshot;
  const tools = [...snapshot.tools];
  let history = snapshot.history;

  for (let index = 0; index < tools.length && size > budget; index++) {
    const tool = tools[index]!;
    if (tool.state === 'running' || !tool.output) continue;
    const empty = { ...tool, output: '', truncated: true };
    const before = bytes(tool);
    const available = budget - size + before - bytes(empty);
    const trimmed = { ...empty, output: available > 0 ? encodedPrefix(tool.output, available) : '' };
    tools[index] = trimmed;
    size += bytes(trimmed) - before;
  }

  if (size > budget && history.entries.length) {
    const start = historyStart(snapshot);
    const outsideHistory = size - bytes(history);
    let entriesBytes = history.entries.reduce((sum, entry) => sum + bytes(entry), 0) + history.entries.length - 1;
    for (let removed = 1; removed <= snapshot.history.entries.length && size > budget; removed++) {
      entriesBytes -= bytes(snapshot.history.entries[removed - 1]!) + (removed < snapshot.history.entries.length ? 1 : 0);
      const end = start + removed;
      if (!Number.isSafeInteger(end)) throw new RangeError('Invalid snapshot history cursor.');
      history = { ...snapshot.history, entries: snapshot.history.entries.slice(removed),
        cursor: encodeHistoryCursor(snapshot.session, snapshot.revision, snapshot.branch, end) };
      size = outsideHistory + bytes({ ...history, entries: [] }) + entriesBytes;
    }
  }

  for (let index = 0; index < tools.length && size > budget;) {
    if (tools[index]!.state === 'running') { index++; continue; }
    size -= bytes(tools[index]) + (tools.length > 1 ? 1 : 0);
    tools.splice(index, 1);
  }

  return { ...snapshot, tools, history };
}

function historyStart(snapshot: SessionSnapshot): number {
  if (!snapshot.history.cursor) return 0;
  let cursor: unknown;
  try { cursor = JSON.parse(Buffer.from(snapshot.history.cursor, 'base64url').toString('utf8')); }
  catch { throw new RangeError('Invalid snapshot history cursor.'); }
  if (!Array.isArray(cursor) || cursor[0] !== snapshot.session || cursor[1] !== snapshot.revision || cursor[2] !== snapshot.branch
    || !Number.isSafeInteger(cursor[3]) || cursor[3] < 0) throw new RangeError('Invalid snapshot history cursor.');
  return cursor[3] as number;
}

function encodedPrefix(text: string, budget: number): string {
  const prefix = (end: number): string => {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end);
  };
  let low = 0; let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(prefix(middle)) - 2 <= budget) low = middle;
    else high = middle - 1;
  }
  return prefix(low);
}
