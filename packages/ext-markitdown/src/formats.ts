export const MARKITDOWN_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.xlsx',
  '.xls',
  '.rtf',
  '.epub',
  '.msg',
] as const;

export const MARKITDOWN_EXCLUDED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.bmp',
  '.tiff',
  '.tif',
  '.gif',
  '.webp',
] as const;

const markitdownExtensionSet: ReadonlySet<string> = new Set(MARKITDOWN_EXTENSIONS);

export function getDocumentExtension(path: string): string {
  const filename = path.split(/[\\/]/u).at(-1) ?? '';
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

export function isMarkitdownDocument(path: string): boolean {
  return markitdownExtensionSet.has(getDocumentExtension(path));
}
