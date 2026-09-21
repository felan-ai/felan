import { MAX_BATCH_SIZE } from './constants.js';
import { selectQueue } from './queue.js';

export function normalizeBatch(items) {
  if (items.length > MAX_BATCH_SIZE) throw new Error('Batch is too large');
  return selectQueue(items.map((item) => String(item).trim()));
}
