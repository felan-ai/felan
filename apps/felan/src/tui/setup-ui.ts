import type { Theme } from '@earendil-works/pi-coding-agent';
import { Container, Input, Key, SelectList, Text, matchesKey, stripTerminalSequences, fuzzyFilter, type SelectItem, type KeybindingsManager, type TUI } from '@earendil-works/pi-tui';
import type { SetupJob } from '@felan-ai/session-protocol';
import type { DependencyInstallOption } from '../dependency-onboarding.js';
import { maskedInputLines, selectionHint, type TuiDialogHost, type TuiDialogs } from './dialogs.js';
import { clientSelectListTheme } from './theme.js';

export interface TerminalSetupUi extends TuiDialogHost {
  isIdle(): boolean;
  providers(title: string, choices: readonly SelectItem[], initialSearch: string | undefined, signal: AbortSignal): Promise<string | undefined>;
  login(job: SetupJob, provider: string, signal: AbortSignal): Promise<string | undefined>;
  checklist(options: readonly DependencyInstallOption[], signal: AbortSignal): Promise<readonly string[] | undefined>;
  progress(job: SetupJob, signal: AbortSignal): Promise<'links' | undefined>;
}

export function createSetupUi(tui: TUI, dialogs: TuiDialogs, theme: () => Theme, keys: KeybindingsManager, canStart: () => boolean = () => true): TerminalSetupUi {
  return {
    isIdle: () => !tui.hasOverlay() && canStart(),
    select: dialogs.select.bind(dialogs), input: dialogs.input.bind(dialogs), confirm: dialogs.confirm.bind(dialogs),
    providers: (title, choices, initialSearch, signal) => dialogs.custom<string | undefined>(done => {
      const content = new Container(); const search = new Input(); search.focused = true;
      search.setValue(initialSearch ?? '');
      const items = choices.map(choice => ({ ...choice, label: stripTerminalSequences(choice.label) }));
      const makeList = () => {
        const list = new SelectList(fuzzyFilter(items, search.getValue(), item => `${item.label} ${item.value} ${item.description ?? ''}`)
          .map(({ value, label }) => ({ value, label })), 8, clientSelectListTheme(theme));
        list.onSelect = item => done(item.value); list.onCancel = () => done(undefined);
        return list;
      };
      let list = makeList();
      content.addChild(new Text(theme().fg('accent', theme().bold(title)), 1, 1));
      content.addChild(search); content.addChild(list);
      return {
        render: width => {
          const border = theme().fg('border', '─'.repeat(width));
          return [border, ...content.render(width), ...new Text(theme().fg('dim', selectionHint(keys)), 1, 0).render(width), border];
        },
        invalidate: () => content.invalidate(),
        handleInput: data => {
          if ((['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel'] as const).some(key => keys.matches(data, key))) list.handleInput(data);
          else {
            const previous = search.getValue(); search.handleInput(data);
            if (search.getValue() !== previous) { content.removeChild(list); list = makeList(); content.addChild(list); }
          }
          tui.requestRender();
        },
      };
    }, { signal }),
    login: (job, provider, signal) => dialogs.custom<string | undefined>(done => {
      const content = new Container(); const colors = theme();
      content.addChild(new Text(colors.fg('accent', colors.bold(`Login to ${stripTerminalSequences(provider)}`)), 1, 0));
      for (const link of job.links ?? []) {
        content.addChild(new Text(colors.fg('accent', stripTerminalSequences(link.url)), 1, 1));
        content.addChild(new Text(colors.fg('warning', stripTerminalSequences(link.label)), 1, 0));
      }
      content.addChild(new Text(colors.fg('dim', stripTerminalSequences(job.message || 'Waiting for authorization…')), 1, 1));
      const prompt = job.state === 'waiting' ? job.prompt : undefined;
      const input = new Input(prompt?.kind === 'input' && prompt.placeholder ? { placeholder: stripTerminalSequences(prompt.placeholder) } : {});
      input.focused = true; input.onSubmit = value => done(value); input.onEscape = () => done(undefined);
      const secret = prompt?.kind === 'input' && prompt.secret;
      let selection: SelectList | undefined;
      if (prompt) {
        content.addChild(new Text(stripTerminalSequences(prompt.message), 1, 0));
        if (prompt.kind === 'select') {
          selection = new SelectList(prompt.choices.map(choice => ({ value: choice.id, label: stripTerminalSequences(choice.label),
            ...(choice.description ? { description: stripTerminalSequences(choice.description) } : {}) })), 8, clientSelectListTheme(theme));
          selection.onSelect = item => done(item.value); selection.onCancel = () => done(undefined);
          content.addChild(selection);
        } else if (!secret) content.addChild(input);
      }
      const hint = new Text(`${prompt ? 'Enter submits · ' : ''}Escape cancels`, 1, 1);
      return {
        render: width => {
          const border = colors.fg('border', '─'.repeat(width));
          return [border, ...content.render(width), ...(secret ? maskedInputLines(input, width, colors) : []), ...hint.render(width), border];
        },
        invalidate: () => { content.invalidate(); hint.invalidate(); },
        handleInput: data => {
          if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, Key.escape)) done(undefined);
          else if (selection) selection.handleInput(data);
          else if (prompt) input.handleInput(data);
          tui.requestRender();
        },
        dispose: () => input.setValue(''),
      };
    }, { signal }),
    checklist: async (options, signal) => {
      const { DependencyInstallationChecklist } = await import('../dependency-onboarding.js');
      if (signal.aborted) return undefined;
      return dialogs.custom<readonly string[] | undefined>(done =>
        new DependencyInstallationChecklist(tui, theme(), keys, options, done), { signal });
    },
    progress: async (job, signal) => {
      const { DependencyInstallProgressLoader } = await import('../dependency-onboarding.js');
      if (signal.aborted) return undefined;
      return dialogs.custom<'links' | undefined>(done => {
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
      }, { signal });
    },
  };
}
