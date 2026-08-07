export type Language = 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'java' | 'c' | 'cpp' | 'unknown';

const LANGUAGE_EXTENSIONS: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
};

interface CommentPatterns {
  line?: string;
  blockStart?: string;
  blockEnd?: string;
  docLine?: string;
  docBlockStart?: string;
}

const COMMENT_PATTERNS: Record<Language, CommentPatterns> = {
  typescript: { line: '//', blockStart: '/*', blockEnd: '*/', docBlockStart: '/**' },
  javascript: { line: '//', blockStart: '/*', blockEnd: '*/', docBlockStart: '/**' },
  python: { line: '#', blockStart: '"""', blockEnd: '"""', docBlockStart: '"""' },
  rust: { line: '//', blockStart: '/*', blockEnd: '*/', docLine: '///', docBlockStart: '/**' },
  go: { line: '//', blockStart: '/*', blockEnd: '*/', docBlockStart: '/**' },
  java: { line: '//', blockStart: '/*', blockEnd: '*/', docBlockStart: '/**' },
  c: { line: '//', blockStart: '/*', blockEnd: '*/', docBlockStart: '/**' },
  cpp: { line: '//', blockStart: '/*', blockEnd: '*/', docBlockStart: '/**' },
  unknown: { line: '//', blockStart: '/*', blockEnd: '*/' },
};

const IMPORT_PATTERN = /^(use\s+|import\s+|from\s+|require\(|#include)/;
const SIGNATURE_PATTERN = /^(pub\s+)?(async\s+)?(fn|def|function|func|class|struct|enum|trait|interface|type)\s+\w+/;
const CONST_PATTERN = /^(const|static|let|pub\s+const|pub\s+static)\s+/;

function getCodePortion(line: string, language: Language): string {
  const patterns = COMMENT_PATTERNS[language];
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let code = '';

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote !== null) {
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (patterns.line && line.startsWith(patterns.line, index)) {
      break;
    }

    if (patterns.blockStart && patterns.blockEnd && line.startsWith(patterns.blockStart, index)) {
      const blockEndIndex = line.indexOf(patterns.blockEnd, index + patterns.blockStart.length);
      if (blockEndIndex === -1) {
        break;
      }
      index = blockEndIndex + patterns.blockEnd.length - 1;
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }

    code += character;
  }

  return code;
}

function countCodeBraces(line: string, language: Language): { open: number; close: number } {
  let open = 0;
  let close = 0;

  for (const character of getCodePortion(line, language)) {
    if (character === '{') {
      open += 1;
    } else if (character === '}') {
      close += 1;
    }
  }

  return { open, close };
}

export function detectLanguage(filePath: string): Language {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) {
    return 'unknown';
  }
  const extension = filePath.slice(lastDot).toLowerCase();
  return LANGUAGE_EXTENSIONS[extension] ?? 'unknown';
}

export function filterMinimal(content: string, language: Language): string {
  const patterns = COMMENT_PATTERNS[language];
  const lines = content.split('\n');
  const result: string[] = [];
  let inBlockComment = false;
  let inDocstring = false;
  let inUserscriptMetadataBlock = false;
  const userscriptMetadataStartPattern = /^\/\/\s*==\s*userscript\s*==$/i;
  const userscriptMetadataContentPattern = /^\/\/\s*@\w+/;
  const userscriptMetadataEndPattern = /^\/\/\s*==\s*\/userscript\s*==$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    const isUserscriptMetadataStart = userscriptMetadataStartPattern.test(trimmed);
    const isUserscriptMetadataContent = userscriptMetadataContentPattern.test(trimmed);
    const isUserscriptMetadataEnd = userscriptMetadataEndPattern.test(trimmed);

    if (isUserscriptMetadataStart) {
      inUserscriptMetadataBlock = true;
      result.push(line);
      continue;
    }

    if (inUserscriptMetadataBlock) {
      result.push(line);
      if (isUserscriptMetadataEnd) {
        inUserscriptMetadataBlock = false;
      } else if (isUserscriptMetadataContent) {
        // Preserve metadata key/value lines (e.g. // @name) within the userscript block.
      }
      continue;
    }

    if (patterns.blockStart && patterns.blockEnd) {
      if (
        !inDocstring &&
        trimmed.includes(patterns.blockStart) &&
        !(patterns.docBlockStart && trimmed.startsWith(patterns.docBlockStart))
      ) {
        inBlockComment = true;
      }

      if (inBlockComment) {
        if (trimmed.includes(patterns.blockEnd)) {
          inBlockComment = false;
        }
        continue;
      }
    }

    if (language === 'python' && trimmed.startsWith('"""')) {
      inDocstring = !inDocstring;
      result.push(line);
      continue;
    }

    if (inDocstring) {
      result.push(line);
      continue;
    }

    if (patterns.line && trimmed.startsWith(patterns.line)) {
      if (patterns.docLine && trimmed.startsWith(patterns.docLine)) {
        result.push(line);
      }
      continue;
    }

    if (trimmed.length === 0) {
      result.push('');
      continue;
    }

    result.push(line);
  }

  return result
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function filterAggressive(content: string, language: Language): string {
  const minimal = filterMinimal(content, language);
  const lines = minimal.split('\n');
  const result: string[] = [];
  let braceDepth = 0;
  let inImplementation = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (IMPORT_PATTERN.test(trimmed)) {
      result.push(line);
      continue;
    }

    if (SIGNATURE_PATTERN.test(trimmed)) {
      result.push(line);
      inImplementation = true;
      braceDepth = 0;
      continue;
    }

    const braces = countCodeBraces(line, language);
    const codeTrimmed = getCodePortion(line, language).trim();

    if (inImplementation) {
      braceDepth += braces.open;
      braceDepth -= braces.close;

      if (braceDepth <= 1 && (codeTrimmed === '{' || codeTrimmed === '}' || codeTrimmed.endsWith('{'))) {
        result.push(line);
      }

      if (braceDepth <= 0) {
        inImplementation = false;
        if (trimmed.length > 0 && trimmed !== '}') {
          result.push('    // ... implementation');
        }
      }
      continue;
    }

    if (CONST_PATTERN.test(trimmed)) {
      result.push(line);
    }
  }

  return result.join('\n').trim();
}

export function smartTruncate(content: string, maxLines: number, _language: Language): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return content;
  }

  const result: string[] = [];
  let keptLines = 0;
  let skippedSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isImportant =
      SIGNATURE_PATTERN.test(trimmed) ||
      IMPORT_PATTERN.test(trimmed) ||
      trimmed.startsWith('pub ') ||
      trimmed.startsWith('export ') ||
      trimmed === '}' ||
      trimmed === '{';

    if (isImportant || keptLines < maxLines / 2) {
      if (skippedSection) {
        result.push(`    // ... ${lines.length - keptLines} lines omitted`);
        skippedSection = false;
      }
      result.push(line);
      keptLines += 1;
    } else {
      skippedSection = true;
    }

    if (keptLines >= maxLines - 1) {
      break;
    }
  }

  if (skippedSection || keptLines < lines.length) {
    result.push(`// ... ${lines.length - keptLines} more lines (total: ${lines.length})`);
  }

  return result.join('\n');
}

export function filterSourceCode(
  content: string,
  language: Language,
  level: 'none' | 'minimal' | 'aggressive',
): string {
  switch (level) {
    case 'none':
      return content;
    case 'minimal':
      return filterMinimal(content, language);
    case 'aggressive':
      return filterAggressive(content, language);
    default:
      return content;
  }
}
