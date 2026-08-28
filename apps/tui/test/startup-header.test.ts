import type { InteractiveMode } from '@earendil-works/pi-coding-agent';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { MEMORY_CONTEXT_CUSTOM_TYPE } from '@felan-ai/ext-memory';
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
      `◉  felan v${FELAN_VERSION}`,
      '   inspect · plan · implement · review',
      '',
      'escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more',
    ].join('\n'));
    expect(header.renderedText).not.toContain(`pi v${PI_VERSION}`);
    expect(header.renderedText).not.toContain('extend Pi');

    header.setExpanded(true);

    expect(header.renderedText).toBe([
      `◉  felan v${FELAN_VERSION}`,
      '   inspect · plan · implement · review',
      '',
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

  it('hides ordinary resource listings while preserving forced resource views', () => {
    const displayed: string[][] = [];
    const mode = {
      builtInHeader: undefined,
      options: { verbose: false },
      settingsManager: { getQuietStartup: () => false },
      session: resourceSession(false, 'AGENTS.md'),
      showLoadedResources(options?: { force?: boolean }) {
        if (options?.force || this.options.verbose || !this.settingsManager.getQuietStartup()) {
          displayed.push(this.session.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path));
        }
      },
    };
    installFelanStartupHeader(mode as unknown as InteractiveMode);

    mode.showLoadedResources();
    expect(displayed).toEqual([]);
    expect(mode.settingsManager.getQuietStartup()).toBe(false);

    mode.showLoadedResources({ force: true });
    expect(displayed).toEqual([['AGENTS.md']]);
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
      `◉  felan v${FELAN_VERSION}`,
      '   inspect · plan · implement · review',
      '',
      'escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more',
    ].join('\n'));
  });

  it('adds loaded project memory to the displayed Context resources only', () => {
    const loaded = resourceMode(true);
    installFelanStartupHeader(loaded.mode, {
      memorySummaryPath: () => '/agent/storage/sessions/session-1/.memory/summary.md',
    });

    loaded.showResources();

    expect(loaded.displayedPaths).toEqual([
      'AGENTS.md',
      '/agent/storage/sessions/session-1/.memory/summary.md',
    ]);
    expect(loaded.actualPaths()).toEqual(['AGENTS.md']);

    const unavailable = resourceMode(false);
    installFelanStartupHeader(unavailable.mode, {
      memorySummaryPath: () => '/agent/storage/sessions/session-1/.memory/summary.md',
    });
    unavailable.showResources();
    expect(unavailable.displayedPaths).toEqual(['AGENTS.md']);
  });

  it('restores the resource loader when Context rendering fails', () => {
    const session = resourceSession(true, 'AGENTS.md');
    const originalDescriptor = Object.getOwnPropertyDescriptor(session.resourceLoader, 'getAgentsFiles');
    const mode = {
      builtInHeader: undefined,
      session,
      showLoadedResources() {
        this.session.resourceLoader.getAgentsFiles();
        throw new Error('Context rendering failed');
      },
    } as unknown as InteractiveMode;
    installFelanStartupHeader(mode, {
      memorySummaryPath: () => '/agent/storage/sessions/session-1/.memory/summary.md',
    });

    expect(() => modeInternalsWithResources(mode).showLoadedResources()).toThrow('Context rendering failed');
    expect(Object.getOwnPropertyDescriptor(session.resourceLoader, 'getAgentsFiles')).toEqual(originalDescriptor);
    expect(session.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path)).toEqual(['AGENTS.md']);
  });

  it('decorates only the current session after replacement', () => {
    const first = resourceSession(true, 'FIRST.md');
    const second = resourceSession(true, 'SECOND.md', 'session-2');
    const displayed: string[][] = [];
    const mode = {
      builtInHeader: undefined,
      session: first,
      showLoadedResources() {
        displayed.push(this.session.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path));
      },
    };
    installFelanStartupHeader(mode as unknown as InteractiveMode, {
      memorySummaryPath: () => `/agent/storage/sessions/${mode.session.sessionManager.getSessionId()}/.memory/summary.md`,
    });

    mode.showLoadedResources();
    mode.session = second;
    mode.showLoadedResources();

    expect(displayed).toEqual([
      ['FIRST.md', '/agent/storage/sessions/session-1/.memory/summary.md'],
      ['SECOND.md', '/agent/storage/sessions/session-2/.memory/summary.md'],
    ]);
    expect(first.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path)).toEqual(['FIRST.md']);
    expect(second.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path)).toEqual(['SECOND.md']);
  });
});

function testMode(): InteractiveMode {
  return { builtInHeader: undefined } as unknown as InteractiveMode;
}

function modeInternals(mode: InteractiveMode): { builtInHeader: Component | undefined } {
  return mode as unknown as { builtInHeader: Component | undefined };
}

function modeInternalsWithResources(mode: InteractiveMode): { showLoadedResources(): void } {
  return mode as unknown as { showLoadedResources(): void };
}

function resourceMode(memoryLoaded: boolean): {
  mode: InteractiveMode;
  displayedPaths: string[];
  actualPaths(): string[];
  showResources(): void;
} {
  const session = resourceSession(memoryLoaded, 'AGENTS.md');
  const displayedPaths: string[] = [];
  const mode = {
    builtInHeader: undefined,
    session,
    showLoadedResources() {
      displayedPaths.push(...this.session.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path));
    },
  };
  return {
    mode: mode as unknown as InteractiveMode,
    displayedPaths,
    actualPaths: () => mode.session.resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path),
    showResources: () => mode.showLoadedResources(),
  };
}

function resourceSession(memoryLoaded: boolean, contextPath: string, sessionId = 'session-1') {
  const contextFiles = [{ path: contextPath, content: 'Project instructions' }];
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      buildContextEntries: () => memoryLoaded
        ? [{ type: 'custom_message', customType: MEMORY_CONTEXT_CUSTOM_TYPE }]
        : [],
    },
    resourceLoader: {
      getAgentsFiles: () => ({ agentsFiles: contextFiles }),
    },
  };
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
