export const MAX_WEB_RESULT_BYTES = 12 * 1024;

const ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export function serializeUntrustedWebContent(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(/[<>&\u2028\u2029]/gu, (character) => ESCAPES[character]!);
}

export function wrapUntrustedWebContent(value: unknown): string {
  return `<untrusted_web_content encoding="json">${serializeUntrustedWebContent(value)}</untrusted_web_content>`;
}
