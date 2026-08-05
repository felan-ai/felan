import type { ExtensionContext, FelanExtension } from '@felan-ai/agent-core';
import { configFromFlags, loadPowerlineConfig, registerPowerlineFlags } from './config.js';
import { PowerlineFooter } from './footer.js';

const powerlineExtension: FelanExtension = (pi) => {
  let footer: PowerlineFooter | undefined;
  const loadedConfig = loadPowerlineConfig(pi.agentDir);

  registerPowerlineFlags(pi, loadedConfig.config);

  function installFooter(ctx: ExtensionContext): void {
    if (ctx.mode !== 'tui') return;
    if (loadedConfig.warning) ctx.ui.notify(loadedConfig.warning, 'warning');
    footer?.dispose();
    ctx.ui.setFooter((tui, _theme, footerData) => {
      footer = new PowerlineFooter({
        pi,
        ctx,
        tui,
        footerData,
        config: configFromFlags(pi, loadedConfig.config),
      });
      return footer;
    });
  }

  function redraw(): void {
    footer?.invalidate();
  }

  pi.on('session_start', (_event, ctx) => installFooter(ctx));
  pi.on('session_shutdown', (_event, ctx) => {
    footer?.dispose();
    footer = undefined;
    if (ctx.mode === 'tui') ctx.ui.setFooter(undefined);
  });

  pi.on('agent_start', redraw);
  pi.on('agent_end', redraw);
  pi.on('turn_end', redraw);
  pi.on('tool_execution_end', redraw);
  pi.on('session_compact', redraw);
  pi.on('session_tree', redraw);
  pi.on('model_select', redraw);
  pi.on('thinking_level_select', redraw);
};

export default powerlineExtension;
export {
  POWERLINE_CONFIG_FILENAME,
  POWERLINE_FLAGS,
  configFromFlags,
  loadPowerlineConfig,
} from './config.js';
export { PowerlineFooter, renderFooterLine, renderStyledSegments } from './footer.js';
export { GitCache, formatAge, parseGitStatus, runGit } from './git.js';
export { formatTokens, renderSegments, sanitizePlainText } from './segments.js';
