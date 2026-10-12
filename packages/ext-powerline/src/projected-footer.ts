import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { getThemePalette, type PiTheme } from './colors.js';
import { renderFooterLine } from './footer-renderer.js';
import { getSymbols } from './symbols.js';
import { parsePowerlineData, type PowerlineData } from './view.js';

export function renderPowerlineData(value: PowerlineData, theme: PiTheme, width: number, extraRows: readonly string[] = []): string[] {
  const data = parsePowerlineData(value);
  const safeWidth = Math.max(0, Math.floor(width));
  if (!Number.isFinite(safeWidth) || safeWidth === 0) return [''];
  const config = { display: { ...data, lines: [] } };
  const palette = getThemePalette(theme); const symbols = getSymbols(data.charset);
  const lines = data.lines.filter(line => line.length).flatMap(line => renderFooterLine(line, config, palette, 'truecolor', symbols, safeWidth));
  return [...(lines.length ? lines : ['']), ...extraRows].map(line => visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, '…'));
}

export class ProjectedPowerlineFooter implements Component {
  private readonly unsubscribe: () => void;
  private disposed = false;
  constructor(private readonly options: {
    data(): PowerlineData | undefined;
    theme(): PiTheme;
    requestRender(): void;
    subscribe(listener: () => void): () => void;
    extraRows?(width: number): readonly string[];
  }) {
    this.unsubscribe = options.subscribe(() => this.invalidate());
  }
  render(width: number): string[] {
    const data = this.options.data();
    return data ? renderPowerlineData(data, this.options.theme(), width, this.options.extraRows?.(width)) : [''];
  }
  invalidate(): void { if (!this.disposed) this.options.requestRender(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribe(); }
}
