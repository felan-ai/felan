import { strict as assert } from 'node:assert';
import { sourceImageTag } from './source-image.mjs';

assert.equal(sourceImageTag('a'.repeat(64)), 'felan-evals-source:aaaaaaaaaaaaaaaaaaaaaaaa');
assert.throws(() => sourceImageTag('not-a-digest'), /64-character/);
console.log('source image helpers passed');
