import type { AgentSession } from '@felan-ai/agent-core';

export const AGENT_VIEW_PRESENTER = Object.freeze({ id: 'felan.agents', version: '1' });
type Message = AgentSession['messages'][number];
export interface AgentViewTranscript {
  agentId: string;
  cwd: string;
  messages: Message[];
  streaming?: Message;
  pendingTools: string[];
  tools?: Array<{ id: string; state: 'running' | 'completed' | 'failed' | 'interrupted'; output: string; truncated: boolean }>;
  compactions?: Array<{ message: number; method: 'Classifier' | 'Summary' | 'Native' }>;
  fallbacks?: Array<{ before: number; text: string }>;
  streamingText?: string;
  result?: string;
  settings: { hideThinking: boolean; showImages: boolean; imageWidthCells: number; outputPad: number; toolMode: 'grouped' | 'full' };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
}
function invalid(): never { throw new Error('Invalid agent presentation data.'); }
export function parseAgentOpenRequest(value: unknown): { agentId?: string } {
  if (!record(value) || Object.keys(value).some(key => key !== 'agentId')) invalid();
  if (value.agentId !== undefined && (typeof value.agentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.agentId))) invalid();
  return value.agentId === undefined ? {} : { agentId: value.agentId };
}
export function parseAgentOpenResult(value: unknown): { opened: true } {
  if (!record(value) || Object.keys(value).some(key => key !== 'opened') || value.opened !== true) invalid();
  return { opened: true };
}
export function parseAgentCatalogSignal(value: unknown): { generation: string } {
  if (!record(value) || Object.keys(value).some(key => key !== 'generation') || typeof value.generation !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.generation)) invalid();
  return { generation: value.generation };
}
