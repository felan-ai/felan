import { prices } from './prices.mjs';
import { threshold } from './threshold.mjs';
export function fee(country, subtotal) { if (!(country in prices)) throw new Error('country'); return country === 'US' && subtotal > threshold ? 0 : prices[country]; }
