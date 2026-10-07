import { available } from './available.mjs';
export const needsReorder = sku => available(sku) < 2;
