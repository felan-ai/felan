export type LocalToolDisplayMode = 'grouped' | 'full';

export function getLocalToolDisplayMode(settings: { getGlobalSettings(): unknown }): LocalToolDisplayMode {
  const raw = settings.getGlobalSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings must be an object');
  const tui = (raw as Record<string, unknown>).felanTui;
  if (tui === undefined) return 'grouped';
  if (!tui || typeof tui !== 'object' || Array.isArray(tui)) throw new Error('felanTui must be an object');
  const mode = (tui as Record<string, unknown>).toolDisplay;
  if (mode === undefined) return 'grouped';
  if (mode === 'grouped' || mode === 'full') return mode;
  throw new Error('felanTui.toolDisplay must be "grouped" or "full"');
}
