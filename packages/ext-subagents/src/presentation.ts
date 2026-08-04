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

export function renderRecords(records: readonly SubagentRecord[]): string {
  return records.length === 0
    ? 'No subagents.'
    : records.map((record) => renderRecord(record)).join('\n\n');
}

export function renderError(error: SubagentError): string {
  return `Subagent error: ${error.code} — ${error.message}`;
}
