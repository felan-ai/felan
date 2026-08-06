import { describe, expect, it } from 'vitest';
import { renderSingleSelectRows } from '../src/single-select-layout.js';

describe('renderSingleSelectRows', () => {
  it('wraps long titles and descriptions', () => {
    const rows = renderSingleSelectRows({
      options: [{
        title: 'A long implementation option that should wrap across several terminal rows',
        description: 'Choose this when architecture and tests both need careful consideration.',
      }],
      selectedIndex: 0,
      width: 32,
      allowFreeform: false,
    });
    const rendered = rows.map((row) => row.line).join(' ').replace(/\s+/g, ' ');
    expect(rendered).toContain('implementation option');
    expect(rendered).toContain('careful consideration');
    expect(rows.length).toBeGreaterThan(3);
  });

  it('caps rows while keeping the selected option visible', () => {
    const rows = renderSingleSelectRows({
      options: [
        { title: 'First long option with enough words to wrap repeatedly' },
        { title: 'Second selected option with enough words to wrap repeatedly' },
      ],
      selectedIndex: 1,
      width: 24,
      allowFreeform: true,
      maxRows: 5,
    });
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.line).join(' ')).toContain('Second selected');
    expect(rows.some((row) => row.selected)).toBe(true);
  });

  it('renders comment and freeform rows in stable order', () => {
    const rows = renderSingleSelectRows({
      options: [{ title: 'Alpha' }],
      selectedIndex: 1,
      width: 50,
      allowComment: true,
      commentEnabled: true,
      allowFreeform: true,
    });
    expect(rows.map((row) => row.line).join('\n')).toContain('[✓] Add extra context');
    expect(rows.at(-1)?.line).toContain('Type something');
  });
});
