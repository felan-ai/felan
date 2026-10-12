import type { ExtensionCommandContext } from '@felan-ai/agent-core';
import type { FusionHost, FusionReview, FusionReviewActions } from '@felan-ai/ext-fusion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalFusionHost } from '../src/fusion/host.js';
import { setExtensionConfigValues } from '../src/settings.js';

vi.mock('../src/settings.js', () => ({ setExtensionConfigValues: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const models = [{ reference: 'one/model', label: 'One' }, { reference: 'two/model', label: 'Two' }];
function fixture() {
  const notify = vi.fn(); const select = vi.fn(); const confirm = vi.fn();
  const context = { model: { provider: 'one', id: 'model' }, ui: { notify, select, confirm } } as unknown as ExtensionCommandContext;
  const presentation: Pick<FusionHost, 'configure' | 'review'> = { configure: vi.fn(), review: vi.fn() };
  return { host: createLocalFusionHost('/isolated/agent', presentation), context, presentation, notify, select, confirm };
}

describe('Fusion daemon host', () => {
  it('retains explicit billing consent and lineup choices', async () => {
    const f = fixture(); f.select.mockResolvedValue('Change models');
    await expect(f.host.selectRunAction!(f.context, models.map(model => model.reference), 'inherit')).resolves.toBe('change');
    expect(f.select).toHaveBeenCalledWith(expect.stringContaining('Provider billing may apply'), ['Run with these models', 'Change models', 'Cancel']);
    f.confirm.mockResolvedValue(false); await expect(f.host.confirm(f.context, 2)).resolves.toBe(false);
  });

  it('persists only an explicitly returned lineup in the daemon', async () => {
    const f = fixture(); const selected = { participants: ['two/model', 'one/model'], fusionModel: 'inherit' };
    vi.mocked(f.presentation.configure).mockResolvedValue(selected);
    await expect(f.host.configure(f.context, models, [], 'inherit')).resolves.toEqual(selected);
    expect(f.presentation.configure).toHaveBeenCalledWith(f.context, models, [], 'inherit');
    expect(setExtensionConfigValues).toHaveBeenCalledExactlyOnceWith('/isolated/agent', 'fusion', selected);
  });

  it('does not persist cancelled selection or open a picker without enough models', async () => {
    const f = fixture(); vi.mocked(f.presentation.configure).mockResolvedValue(undefined);
    await expect(f.host.configure(f.context, models, [], 'inherit')).resolves.toBeUndefined();
    await expect(f.host.configure(f.context, [], [], 'inherit')).resolves.toBeUndefined();
    expect(f.presentation.configure).toHaveBeenCalledOnce(); expect(setExtensionConfigValues).not.toHaveBeenCalled();
  });

  it('reports storage failure without returning a successful selection', async () => {
    const f = fixture(); vi.mocked(f.presentation.configure).mockResolvedValue({ participants: ['one/model', 'two/model'], fusionModel: 'inherit' });
    vi.mocked(setExtensionConfigValues).mockRejectedValue(new Error('storage failure'));
    await expect(f.host.configure(f.context, models, [], 'inherit')).resolves.toBeUndefined();
    expect(f.notify).toHaveBeenCalledWith('Could not save Fusion model choices. No model requests were started.', 'error');
  });

  it('passes review data and daemon actions without invoking them', async () => {
    const f = fixture(); const getReview = () => ({}) as FusionReview;
    const actions = { fuse: vi.fn() } as unknown as FusionReviewActions;
    await f.host.review(f.context, getReview, actions);
    expect(f.presentation.review).toHaveBeenCalledExactlyOnceWith(f.context, getReview, actions);
    expect(actions.fuse).not.toHaveBeenCalled();
  });
});
