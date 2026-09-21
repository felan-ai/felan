import { dispatchBatch } from './dispatch.js';

export function selectQueue(items) {
  return dispatchBatch(items, items.some((item) => item.startsWith('urgent:')) ? 'priority' : 'standard');
}
