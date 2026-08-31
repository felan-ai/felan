import type { Analytics } from './types.js';
import { REPORT_APP_SCRIPT, REPORT_APP_STYLE, REPORT_FAVICON } from './generated/report-app.js';

const themeBootstrap = `(()=>{const key='felan-insights-theme';let theme;try{theme=localStorage.getItem(key)}catch{}if(theme!=='light'&&theme!=='dark')theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=theme})()`;

export function renderReport(analytics: Analytics): string {
  const data = JSON.stringify(analytics).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#255f44"><link rel="icon" type="image/svg+xml" href="${REPORT_FAVICON}"><title>Felan Insights</title><style>${REPORT_APP_STYLE}</style><script>${themeBootstrap}</script></head><body><div id="root"></div><script>window.__FELAN_INSIGHTS_DATA__=${data};</script><script>${REPORT_APP_SCRIPT.replace(/<\//gu, '<\\/')}</script></body></html>`;
}
