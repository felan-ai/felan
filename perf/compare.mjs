#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const files = process.argv.slice(2);
if (files.length !== 2) throw new Error('Usage: node perf/compare.mjs before.json after.json');
const [before, after] = files.map(file => JSON.parse(readFileSync(file, 'utf8')));
if (before.quick !== after.quick || before.profile !== after.profile || JSON.stringify(before.machine) !== JSON.stringify(after.machine)) console.warn('Warning: different machine, runtime, sampling, or profiling configuration.');
const key = row => `${row.suite}/${row.name}`;
const previous = new Map(before.results.map(row => [key(row), row]));
console.table(after.results.map(row => {
  const old = previous.get(key(row));
  return { metric: key(row), status: row.status, before: old?.value, after: row.value, unit: row.unit, change: old?.status === 'ok' && row.status === 'ok' && old.unit === row.unit && old.value !== 0 ? `${((row.value / old.value - 1) * 100).toFixed(1)}%` : 'n/a' };
}));
const afterKeys = new Set(after.results.map(key));
for (const row of before.results) if (!afterKeys.has(key(row))) console.log(`Missing after: ${key(row)}`);
