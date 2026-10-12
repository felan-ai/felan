import type { Theme } from '@earendil-works/pi-coding-agent';
import { Key, Text, matchesKey, stripTerminalSequences, type KeybindingsManager, type TUI } from '@earendil-works/pi-tui';
import type { SetupJob } from '@felan-ai/session-protocol';
import { DependencyInstallationChecklist, DependencyInstallProgressLoader, type DependencyInstallOption } from '../dependency-onboarding.js';
import type { TuiDialogHost, TuiDialogs } from './dialogs.js';

export interface TerminalSetupUi extends TuiDialogHost {
  isIdle(): boolean;
  checklist(options: readonly DependencyInstallOption[], signal: AbortSignal): Promise<readonly string[] | undefined>;
  progress(job: SetupJob, signal: AbortSignal): Promise<'links' | undefined>;
}

export function createSetupUi(tui: TUI, dialogs: TuiDialogs, theme: () => Theme, keys: KeybindingsManager, canStart: () => boolean = () => true): TerminalSetupUi {
  return {
    isIdle: () => !tui.hasOverlay() && canStart(),
    select: dialogs.select.bind(dialogs), input: dialogs.input.bind(dialogs), confirm: dialogs.confirm.bind(dialogs),
    checklist: (options, signal) => dialogs.custom<readonly string[] | undefined>(done =>
      new DependencyInstallationChecklist(tui, theme(), keys, options, done), { signal }),
    progress: (job, signal) => dialogs.custom<'links' | undefined>(done => {
      const loader = new DependencyInstallProgressLoader(tui, theme(), stripTerminalSequences(job.message || 'Waiting for daemon setup…'));
      const hint = new Text(`${job.links?.length ? 'L opens setup links · ' : ''}Escape cancels this setup job`, 1, 1);
      return {
        render: width => [...loader.render(width), ...hint.render(width)],
        invalidate: () => { loader.invalidate(); hint.invalidate(); },
        handleInput: data => {
          if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.escape)) done(undefined);
          else if (job.links?.length && data.toLowerCase() === 'l') done('links');
        },
        dispose: () => loader.dispose(),
      };
    }, { signal }),
  };
}
