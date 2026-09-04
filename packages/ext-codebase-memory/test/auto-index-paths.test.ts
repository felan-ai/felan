import { describe, expect, it } from 'vitest';
import { validateAutoIndexPath } from '../src/auto-index-paths.js';

describe('validateAutoIndexPath', () => {
  it('accepts a normal project path', () => {
    expect(validateAutoIndexPath('/Users/alice/Projects/felan')).toEqual({
      ok: true,
      path: '/Users/alice/Projects/felan',
    });
    expect(validateAutoIndexPath('C:\\Users\\alice\\Projects\\felan')).toEqual({
      ok: true,
      path: 'C:/Users/alice/Projects/felan',
    });
  });

  it('rejects filesystem roots', () => {
    expect(validateAutoIndexPath('/')).toEqual({ ok: false, reason: expect.stringContaining('filesystem root') });
    expect(validateAutoIndexPath('C:\\')).toEqual({ ok: false, reason: expect.stringContaining('filesystem root') });
    expect(validateAutoIndexPath('C:/')).toEqual({ ok: false, reason: expect.stringContaining('filesystem root') });
    expect(validateAutoIndexPath('d:')).toEqual({ ok: false, reason: expect.stringContaining('filesystem root') });
  });

  it('rejects known system directories', () => {
    for (const path of [
      '/System', '/usr', '/etc', '/var', '/Library', '/private', '/tmp', '/opt',
      'C:\\Windows', 'c:\\windows\\', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Users',
    ]) {
      expect(validateAutoIndexPath(path)).toEqual({ ok: false, reason: expect.stringContaining('system directory') });
    }
  });

  it('rejects the home directory itself', () => {
    expect(validateAutoIndexPath('/Users/alice')).toEqual({ ok: false, reason: 'refusing to auto-index home directory' });
    expect(validateAutoIndexPath('/home/bob')).toEqual({ ok: false, reason: 'refusing to auto-index home directory' });
    expect(validateAutoIndexPath('C:\\Users\\alice')).toEqual({ ok: false, reason: 'refusing to auto-index home directory' });
    expect(validateAutoIndexPath('c:/users/bob')).toEqual({ ok: false, reason: 'refusing to auto-index home directory' });
  });

  it('rejects common home builtin directories', () => {
    for (const dir of ['Downloads', 'Documents', 'Desktop', 'Library', 'Movies', 'Music', 'Pictures']) {
      expect(validateAutoIndexPath(`/Users/alice/${dir}`)).toEqual({
        ok: false,
        reason: 'refusing to auto-index builtin user directory',
      });
      expect(validateAutoIndexPath(`C:\\Users\\alice\\${dir}`)).toEqual({
        ok: false,
        reason: 'refusing to auto-index builtin user directory',
      });
    }
    expect(validateAutoIndexPath('C:\\Users\\alice\\desktop')).toEqual({
      ok: false,
      reason: 'refusing to auto-index builtin user directory',
    });
  });

  it('accepts deeper paths under home', () => {
    expect(validateAutoIndexPath('/Users/alice/code/thing')).toEqual({
      ok: true,
      path: '/Users/alice/code/thing',
    });
    expect(validateAutoIndexPath('C:\\Users\\alice\\code\\thing')).toEqual({
      ok: true,
      path: 'C:/Users/alice/code/thing',
    });
  });

  it('rejects empty paths', () => {
    expect(validateAutoIndexPath('')).toEqual({ ok: false, reason: 'path is empty' });
  });

  it('normalizes trailing slashes and backslashes', () => {
    expect(validateAutoIndexPath('/Users/alice/Projects/felan/')).toEqual({
      ok: true,
      path: '/Users/alice/Projects/felan',
    });
    expect(validateAutoIndexPath('C:\\Users\\alice\\Projects\\felan\\')).toEqual({
      ok: true,
      path: 'C:/Users/alice/Projects/felan',
    });
  });
});
