import { describe, expect, it } from 'vitest';
import {
  collectFileLists,
  formatFileLists,
  latestCompactionDetails,
  MAX_FILE_LIST_ENTRIES,
  MAX_FILE_PATH_BYTES,
  stripFileLists,
} from '../src/internal/file-lists.js';

describe('compaction file lists', () => {
  it('matches Pi sorting and read-minus-modified behavior', () => {
    const lists = collectFileLists({
      read: new Set(['z.ts', 'written.ts', 'a.ts', 'edited.ts']),
      written: new Set(['written.ts', 'both.ts']),
      edited: new Set(['edited.ts', 'both.ts']),
    }, undefined);

    expect(lists).toEqual({ readFiles: ['a.ts', 'z.ts'], modifiedFiles: ['both.ts', 'edited.ts', 'written.ts'] });
    expect(formatFileLists(lists)).toBe(
      '\n\n<read-files>\na.ts\nz.ts\n</read-files>\n\n<modified-files>\nboth.ts\nedited.ts\nwritten.ts\n</modified-files>',
    );
  });

  it.each([
    { readFiles: [], modifiedFiles: [], expected: '' },
    { readFiles: ['read.ts'], modifiedFiles: [], expected: '\n\n<read-files>\nread.ts\n</read-files>' },
    { readFiles: [], modifiedFiles: ['write.ts'], expected: '\n\n<modified-files>\nwrite.ts\n</modified-files>' },
  ])('omits empty Pi sections: $expected', ({ readFiles, modifiedFiles, expected }) => {
    expect(formatFileLists({ readFiles, modifiedFiles })).toBe(expected);
  });

  it('merges previous lists with array operations and removes reads modified in either span', () => {
    const fileOps = { read: ['old-modified.ts', 'new-read.ts', 'old-read.ts'], written: ['new-write.ts'], edited: ['old-read.ts'] };
    const previous = { readFiles: ['old-read.ts', 'new-write.ts', 'unchanged.ts'], modifiedFiles: ['old-modified.ts', 'old-modified.ts'] };

    expect(collectFileLists(fileOps, previous)).toEqual({
      readFiles: ['new-read.ts', 'unchanged.ts'],
      modifiedFiles: ['new-write.ts', 'old-modified.ts', 'old-read.ts'],
    });
    expect(fileOps.read).toEqual(['old-modified.ts', 'new-read.ts', 'old-read.ts']);
    expect(previous.readFiles).toEqual(['old-read.ts', 'new-write.ts', 'unchanged.ts']);
  });

  it('bounds each merged list after sorting and excludes modified paths before slicing', () => {
    const paths = Array.from({ length: MAX_FILE_LIST_ENTRIES + 25 }, (_, index) => `${index}`.padStart(3, '0'));
    const read = paths.map((path) => `read-${path}`);
    const modified = paths.map((path) => `modified-${path}`);
    const lists = collectFileLists({ read: [...read, modified.at(-1)].reverse(), written: modified.slice(100).reverse() }, {
      readFiles: [read[0]],
      modifiedFiles: modified.slice(0, 100).reverse(),
    });

    expect(lists.readFiles).toEqual(read.slice(0, MAX_FILE_LIST_ENTRIES));
    expect(lists.modifiedFiles).toEqual(modified.slice(0, MAX_FILE_LIST_ENTRIES));
  });

  it('sanitizes, deduplicates, and bounds paths in UTF-8 bytes', () => {
    const ascii = 'a'.repeat(MAX_FILE_PATH_BYTES + 10);
    const unicode = '😀'.repeat(MAX_FILE_PATH_BYTES);
    const lists = collectFileLists({
      read: [' clean.ts ', '\u0000clean.ts', '\u202eclean.ts', '', '  ', '\u0000', 'one\ntwo', 'one\r\ntwo', 'one\rtwo', ascii, unicode],
      edited: [' modified.ts ', 'modified.ts'],
    }, { readFiles: ['clean.ts'], modifiedFiles: ['\u0000modified.ts', 'bad\npath'] });

    expect(lists).toEqual({
      readFiles: ['a'.repeat(MAX_FILE_PATH_BYTES), 'clean.ts', '😀'.repeat(MAX_FILE_PATH_BYTES / 4)],
      modifiedFiles: ['modified.ts'],
    });
    for (const path of [...lists.readFiles, ...lists.modifiedFiles]) {
      expect(new TextEncoder().encode(path).byteLength).toBeLessThanOrEqual(MAX_FILE_PATH_BYTES);
    }
    expect(collectFileLists({ read: [' clean.ts '] }, { modifiedFiles: ['\u0000clean.ts'] })).toEqual({
      readFiles: [], modifiedFiles: ['clean.ts'],
    });
  });

  it.each([undefined, null, 1, false, 'file.ts', [], new Map()])('ignores malformed top-level input: %j', (value) => {
    expect(collectFileLists(value, value)).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it('accepts only Set or array operations and only array previous details', () => {
    const iterable = { *[Symbol.iterator]() { yield 'unexpected.ts'; } };
    expect(collectFileLists({ read: iterable, written: 'file.ts', edited: new Map([['key', 'value']]) }, {
      readFiles: new Set(['unexpected.ts']), modifiedFiles: iterable,
    })).toEqual({ readFiles: [], modifiedFiles: [] });
    expect(collectFileLists({ read: [null, undefined, 1, {}, ['nested.ts'], 'valid.ts'], written: new Set([false, 'write.ts']) }, {
      readFiles: [false, 'previous.ts'], modifiedFiles: [1, 'old-write.ts'],
    })).toEqual({ readFiles: ['previous.ts', 'valid.ts'], modifiedFiles: ['old-write.ts', 'write.ts'] });
  });
});

describe('stripFileLists', () => {
  it('removes both model-written lists and trims the remaining summary', () => {
    const summary = '  Preserve the decision.\n\n<read-files>\nmade-up.ts\n</read-files>\n\n<modified-files>\nnot-written.ts\n</modified-files>\n ';
    expect(stripFileLists(summary)).toBe('Preserve the decision.');
  });

  it('removes repeated, inline, and case-varied blocks without removing other markup', () => {
    expect(stripFileLists('<read-files>a</read-files>Keep <other>evidence</other>.<MODIFIED-FILES>b</MODIFIED-FILES><read-files>c</read-files>'))
      .toBe('Keep <other>evidence</other>.');
    expect(stripFileLists('  No file lists.  ')).toBe('No file lists.');
    expect(stripFileLists('\n<read-files>\n</read-files>\n<modified-files>\n</modified-files>\n')).toBe('');
  });
});

describe('latestCompactionDetails', () => {
  it('returns the last compaction details, ignoring later non-compaction entries', () => {
    const details = { readFiles: ['latest.ts'] };
    expect(latestCompactionDetails([
      { type: 'compaction', details: { readFiles: ['old.ts'] } },
      { type: 'compaction', details },
      { type: 'message', details: { readFiles: ['message.ts'] } },
    ])).toBe(details);
  });

  it('returns undefined when there is no compaction or the latest has no details', () => {
    expect(latestCompactionDetails([])).toBeUndefined();
    expect(latestCompactionDetails([{ type: 'message', details: {} }])).toBeUndefined();
    expect(latestCompactionDetails([{ type: 'compaction', details: {} }, { type: 'compaction' }])).toBeUndefined();
  });
});
