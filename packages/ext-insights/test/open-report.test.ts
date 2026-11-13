import type { AgentRuntime, ExtensionUi } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import { openReportOnHost } from '../src/open-report.js';

function fixture(code = 0, stderr = '', killed = false) {
  const exec = vi.fn(async () => ({ code, stderr, killed, stdout: '' }));
  const ui = { canRequest: vi.fn(() => true), request: vi.fn<ExtensionUi['request']>().mockResolvedValue({
    state: 'answered', answer: { kind: 'form', outcome: 'submit', actionId: 'open', values: {} },
  }) };
  return { exec, ui, runtime: { exec } as unknown as AgentRuntime, path: 'report with spaces.html', signal: new AbortController().signal };
}

it('opens the report with literal argv after host confirmation', async () => {
  const options = fixture();
  await expect(openReportOnHost(options)).resolves.toBe('opened');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  expect(options.exec).toHaveBeenCalledWith(command, [options.path]);
  expect(options.ui.request).toHaveBeenCalledWith(expect.anything(), { audience: 'host', signal: options.signal });
});

it('does not open a report without host confirmation', async () => {
  const options = fixture();
  options.ui.canRequest.mockReturnValue(false);
  await expect(openReportOnHost(options)).resolves.toBe('unavailable');
  expect(options.ui.request).not.toHaveBeenCalled();
  options.ui.canRequest.mockReturnValue(true);
  options.ui.request.mockResolvedValue({ state: 'answered', answer: { kind: 'form', outcome: 'cancel', actionId: 'cancel', values: {} } });
  await expect(openReportOnHost(options)).resolves.toBe('declined');
  expect(options.exec).not.toHaveBeenCalled();
});

it('reports an opener failure', async () => {
  await expect(openReportOnHost(fixture(17))).resolves.toBe('failed');
});

it.skipIf(process.platform === 'win32')('keeps exit code 1 as a failure on POSIX', async () => {
  await expect(openReportOnHost(fixture(1))).resolves.toBe('failed');
});

it.runIf(process.platform === 'win32')('accepts Explorer exit code 1 without treating spawn errors or termination as success', async () => {
  await expect(openReportOnHost(fixture(1))).resolves.toBe('opened');
  await expect(openReportOnHost(fixture(1, 'spawn ENOENT'))).resolves.toBe('failed');
  await expect(openReportOnHost(fixture(1, '', true))).resolves.toBe('failed');
});
