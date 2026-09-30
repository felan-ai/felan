import { formatModelReference, type ModelRuntime, type SettingsManager } from '@felan-ai/agent-core';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings, SettingsList, Text, type Component, type SettingItem } from '@earendil-works/pi-tui';
import { getClassifierModelSetting, setClassifierModelSetting } from './settings.js';

export function createClassifierModelSettings(
  options: {
    readonly agentDir: string;
    readonly settingsManager: SettingsManager;
    readonly modelRuntime: Pick<ModelRuntime, 'getAvailableOfType'>;
  },
  close: (selected?: string) => void,
  requestRender: () => void,
): Component & { dispose(): void } {
  const saved = getClassifierModelSetting(options.settingsManager);
  const theme = getSettingsListTheme();
  let closed = false;
  let saving = false;
  let status = 'Loading authenticated classifier models…';
  let list: SettingsList | undefined;
  let listTop = 0;
  const cancel = () => { closed = true; close(); };
  const showModels = (references: readonly string[]) => {
    if (closed) return;
    const items: SettingItem[] = ['auto', ...new Set(references)].map(reference => ({
      id: reference,
      label: reference === 'auto' ? 'Auto' : reference,
      currentValue: reference === saved ? 'selected' : 'choose',
      values: ['choose'],
      description: reference === 'auto'
        ? 'Prefer available Jev models, then the first configured classifier. Applies to the next new root session/restart.'
        : 'Use this exact classifier. If unavailable, warn and use Auto. Applies to the next new root session/restart.',
    }));
    list = new SettingsList(items, 12, theme, reference => {
      if (saving || closed) return;
      saving = true;
      status = 'Saving classifier model…';
      requestRender();
      void (async () => {
        try {
          await setClassifierModelSetting(options.agentDir, reference);
          await options.settingsManager.reload().catch(() => {});
          if (!closed) {
            closed = true;
            close(reference);
            requestRender();
          }
        } catch {
          if (closed) return;
          saving = false;
          status = 'Save failed; the previous classifier setting is unchanged.';
          for (const item of items) list?.updateValue(item.id, item.id === saved ? 'selected' : 'choose');
        }
        if (!closed) requestRender();
      })();
    }, cancel, { enableSearch: true });
    list.selectItem(saved);
    requestRender();
  };

  void options.modelRuntime.getAvailableOfType('classifier').then(models => {
    if (closed) return;
    const references = models.map(formatModelReference);
    status = models.length === 0 ? 'No authenticated classifier models. Auto retains normal feature fallbacks.'
      : saved !== 'auto' && !references.includes(saved) ? 'Saved classifier is unavailable; the runtime will warn and use Auto.' : '';
    showModels(references);
  }).catch(() => {
    if (closed) return;
    status = 'Classifier model lookup failed. Choose Auto or press Escape to keep the saved setting.';
    showModels([]);
  });

  return {
    render(width) {
      const heading = new Text(theme.label('Classifier model', true), 0, 0).render(width);
      const current = new Text(theme.description(`Saved: ${saved} · Applies to the next new root session/restart.`), 0, 0).render(width);
      const message = status ? new Text(theme.description(status), 0, 0).render(width) : [];
      const prefix = [...heading, ...current, ...message, ''];
      listTop = prefix.length;
      return [...prefix, ...(list?.render(width) ?? [])];
    },
    invalidate() { list?.invalidate(); },
    handleInput(data) {
      if (closed) return;
      if (getKeybindings().matches(data, 'tui.select.cancel')) { cancel(); return; }
      if (!saving) list?.handleInput(data);
    },
    handleMouse(event) {
      if (closed || saving || event.y < listTop) return undefined;
      return list?.handleMouse({ ...event, y: event.y - listTop });
    },
    dispose() { closed = true; },
  };
}
