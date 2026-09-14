export function sourceImageTag(digest) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('source digest must be a 64-character hexadecimal hash');
  return `felan-evals-source:${digest.slice(0, 24)}`;
}
