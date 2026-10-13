export function parseApprovalExemptTools(options: unknown): readonly string[] {
  if (options === undefined) return [];
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Session-runtime options must be an object.');
  const value: unknown = Reflect.get(options, 'approvalExemptTools');
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some(name => typeof name !== 'string' || !name || name.length > 128)) {
    throw new Error('approvalExemptTools must be a bounded array of tool names.');
  }
  return Object.freeze([...new Set(value as string[])]);
}
