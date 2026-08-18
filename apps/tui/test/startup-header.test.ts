import type { InteractiveMode } from '@earendil-works/pi-coding-agent';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { FELAN_VERSION } from '../src/version.js';
import {
  installFelanStartupHeader,
  rewritePiStartupHeader,
} from '../src/startup-header.js';

describe('Felan startup header', () => {
  it('rewrites the built-in collapsed and expanded text before it can render', () => {
    const mode = testMode();
    installFelanStartupHeader(mode);
    const header = new FakeExpandableHeader();

    modeInternals(mode).builtInHeader = header;

    expect(header.renderedText).toBe([
      `felan v${FELAN_VERSION}`,
      'escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more',
      'Press ctrl+o to show full startup help and loaded resources.',
    ].join('\n'));
    expect(header.renderedText).not.toContain(`pi v${PI_VERSION}`);
    expect(header.renderedText).not.toContain('extend Pi');

    header.setExpanded(true);

    expect(header.renderedText).toBe([
      `felan v${FELAN_VERSION}`,
      'escape to interrupt',
      'ctrl+c to clear',
      'ctrl+c twice to exit',
    ].join('\n'));
    expect(header.renderedText).not.toContain('Pi can explain');
    expect(header.renderedText).not.toContain('extend Pi');
  });

  it('preserves a quiet startup header without introducing replacement text', () => {
    const mode = testMode();
    installFelanStartupHeader(mode);
    const quietHeader = new EmptyHeader();

    modeInternals(mode).builtInHeader = quietHeader;

    expect(quietHeader.render()).toEqual([]);
  });

  it('preserves Pi verbose startup expansion when installing the adapter', () => {
    const mode = testMode();
    installFelanStartupHeader(mode, { expanded: true });
    const header = new FakeExpandableHeader();

    modeInternals(mode).builtInHeader = header;

    expect(header.renderedText).toContain('escape to interrupt');
    expect(header.renderedText).not.toContain('Press ctrl+o');
    expect(header.renderedText).not.toContain('Pi can explain');
  });

  it('rewrites only the upstream logo and onboarding paragraph', () => {
    const source = [
      `pi v${PI_VERSION}`,
      'escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more',
      'Press ctrl+o to show full startup help and loaded resources.',
      '',
      'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.',
    ].join('\n');

    expect(rewritePiStartupHeader(source)).toBe([
      `felan v${FELAN_VERSION}`,
      'escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more',
      'Press ctrl+o to show full startup help and loaded resources.',
    ].join('\n'));
  });
});

function testMode(): InteractiveMode {
  return { builtInHeader: undefined } as unknown as InteractiveMode;
}

function modeInternals(mode: InteractiveMode): { builtInHeader: Component | undefined } {
  return mode as unknown as { builtInHeader: Component | undefined };
}

class FakeExpandableHeader implements Component {
  renderedText = '';
  private readonly collapsedText = [
    `pi v${PI_VERSION}`,
    'escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more',
    'Press ctrl+o to show full startup help and loaded resources.',
    '',
    'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.',
  ].join('\n');
  private readonly expandedText = [
    `pi v${PI_VERSION}`,
    'escape to interrupt',
    'ctrl+c to clear',
    'ctrl+c twice to exit',
    'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.',
  ].join('\n');

  constructor() {
    this.setExpanded(false);
  }

  getCollapsedText(): string {
    return this.collapsedText;
  }

  getExpandedText(): string {
    return this.expandedText;
  }

  setExpanded(expanded: boolean): void {
    this.renderedText = expanded ? this.getExpandedText() : this.getCollapsedText();
  }

  render(): string[] {
    return this.renderedText.length === 0 ? [] : [this.renderedText];
  }

  invalidate(): void {}
}

class EmptyHeader implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}
