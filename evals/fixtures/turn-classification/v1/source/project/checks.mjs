import assert from 'node:assert/strict';
import { available } from './inventory/available.mjs';
import { discount } from './billing/discount.mjs';
assert.equal(available('A'), 9);
assert.equal(discount(1000,true),100);
