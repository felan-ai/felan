import { stock } from './stock.mjs';
import { reserved } from './reserved.mjs';
export const available = sku => (stock[sku] ?? 0) - (reserved[sku] ?? 0);
