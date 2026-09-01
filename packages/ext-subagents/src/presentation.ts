import type { SubagentError, SubagentRecord } from './contracts.js';

export function renderRecord(record: SubagentRecord): string {
  const lines = [
    `agent_id: ${record.agentId}`,
    `status: ${record.status}`,
    `type: ${record.type}`,
    `description: ${record.description}`,
  ];
  if (record.result !== undefined) lines.push(`result:\n${record.result}`);
  if (record.error !== undefined) lines.push(`error: ${record.error.code} — ${record.error.message}`);
  return lines.join('\n');
}

export function renderRecords(records: readonly SubagentRecord[], limit?: number): string {
  return records.length === 0
    ? 'No subagents.'
    : [
        records.map(renderStatusRecord).join('\n\n'),
        ...(limit !== undefined && records.length >= limit
          ? [`Showing at most ${limit} subagents; use get_subagent_result for a specific child.`]
          : []),
      ].join('\n\n');
}

export function compactRecords(records: readonly SubagentRecord[]): readonly SubagentRecord[] {
  return records.map(({ result: _result, error: _error, ...record }) => record);
}

function renderStatusRecord(record: SubagentRecord): string {
  return [
    `agent_id: ${record.agentId}`,
    `status: ${record.status}`,
    `type: ${record.type}`,
    `description: ${record.description}`,
  ].join('\n');
}

export function renderError(error: SubagentError): string {
  return `Subagent error: ${error.code} — ${error.message}`;
}
