import { describe, expect, it, vi } from 'vitest';
import { installPromptHistoryKeybindingOverride, removePromptHistoryShortcutFromSessionRename } from '../src/prompt-history.js';

describe('prompt history client keybindings', () => {
  it('unsets Pi session rename on Ctrl+R while preserving explicit alternatives', () => {
    let bindings: Record<string, string | string[] | undefined> = {};
    const keybindings = {
      getUserBindings: () => bindings,
      setUserBindings: (next: typeof bindings) => { bindings = next; },
    };

    removePromptHistoryShortcutFromSessionRename(keybindings);
    expect(bindings['app.session.rename']).toEqual([]);

    bindings = { 'app.session.rename': ['ctrl+r', 'alt+r'], 'app.session.delete': 'ctrl+d' };
    removePromptHistoryShortcutFromSessionRename(keybindings);
    expect(bindings).toEqual({
      'app.session.rename': ['alt+r'],
      'app.session.delete': 'ctrl+d',
    });
  });

  it('reapplies the Ctrl+R override after Pi reloads keybindings', () => {
    let bindings: Record<string, string | string[] | undefined> = {};
    const reload = vi.fn(() => { bindings = {}; });
    const keybindings = {
      getUserBindings: () => bindings,
      setUserBindings: (next: typeof bindings) => { bindings = next; },
      reload,
    };

    installPromptHistoryKeybindingOverride({ keybindings });
    expect(bindings['app.session.rename']).toEqual([]);
    keybindings.reload();
    expect(reload).toHaveBeenCalledOnce();
    expect(bindings['app.session.rename']).toEqual([]);
  });

});
