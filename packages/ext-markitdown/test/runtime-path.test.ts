import { describe, expect, it } from 'vitest';
import { getDocumentExtension } from '../src/formats.js';
import { isWindowsRuntimePath, joinRuntimePath } from '../src/runtime-path.js';

describe('runtime path handling', () => {
  it('joins paths according to the runtime root rather than the controller platform', () => {
    expect(joinRuntimePath('/session/storage', 'markitdown/cache', 'file.md')).toBe(
      '/session/storage/markitdown/cache/file.md',
    );
    expect(joinRuntimePath('C:\\Users\\agent\\storage', 'markitdown/cache', 'file.md')).toBe(
      'C:\\Users\\agent\\storage\\markitdown\\cache\\file.md',
    );
    expect(joinRuntimePath('C:/Users/agent/storage', 'markitdown/cache')).toBe(
      'C:\\Users\\agent\\storage\\markitdown\\cache',
    );
    expect(isWindowsRuntimePath('C:/Users/agent/storage')).toBe(true);
    expect(isWindowsRuntimePath('/agent/storage')).toBe(false);
  });

  it('detects extensions across POSIX and Windows separators', () => {
    expect(getDocumentExtension('/workspace/report.DOCX')).toBe('.docx');
    expect(getDocumentExtension('C:\\workspace\\report.PPTX')).toBe('.pptx');
    expect(getDocumentExtension('/workspace/archive.tar.gz')).toBe('.gz');
  });
});
