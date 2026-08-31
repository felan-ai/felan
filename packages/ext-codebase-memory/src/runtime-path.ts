export function joinRuntimePath(root: string, ...parts: string[]): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return [root.replace(/[\\/]+$/u, ''), ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/gu, ''))]
    .filter(Boolean)
    .join(separator);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
