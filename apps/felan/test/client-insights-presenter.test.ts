import { expect, it, vi } from 'vitest';
import { registerInsightsPresenter } from '../src/client/insights-presenter.js';
import type { ClientInteractionPresenters } from '../src/client/presenters.js';

it('opens only after explicit local confirmation and does not auto-open a replay', async () => {
  let handler!: Parameters<ClientInteractionPresenters['registerCustom']>[1];
  const openReport = vi.fn().mockResolvedValue(undefined); const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const remove = registerInsightsPresenter({ registerCustom(_id, value) { handler = value; return () => {}; } }, { confirm }, { openReport });
  const request = { path: '/tmp/agent/insights-reports/felan-insights.html' };
  try {
    expect(await handler(request, new AbortController().signal)).toEqual({ opened: true });
    expect(await handler(request, new AbortController().signal)).toEqual({ opened: false });
    expect(openReport).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledTimes(2);
    await expect(handler({ path: 'https://example.com/report' }, new AbortController().signal)).rejects.toThrow();
    expect(openReport).toHaveBeenCalledOnce();
  } finally { remove(); }
});

it('does not open when cancelled during confirmation', async () => {
  let handler!: Parameters<ClientInteractionPresenters['registerCustom']>[1]; const control = new AbortController();
  const openReport = vi.fn();
  const remove = registerInsightsPresenter({ registerCustom(_id, value) { handler = value; return () => {}; } },
    { confirm: async () => { control.abort(); return true; } }, { openReport });
  try {
    expect(await handler({ path: '/tmp/insights-reports/felan-insights.html' }, control.signal)).toBeUndefined();
    expect(openReport).not.toHaveBeenCalled();
  } finally { remove(); }
});
