#!/usr/bin/env node
// Adapted from awesome-pi-themes' preview-themes-web.js at commit
// c75595966366147d747c31ba9db5c7acead2d0b1.
// Copyright (c) 2026 Isashi Mitsui. MIT License.

import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const themesDir = join(repoRoot, "apps", "tui", "src", "themes");
const pagesDir = join(repoRoot, ".artifacts", "theme-preview");
const pagesIndex = join(pagesDir, "index.html");
const felanVersion = JSON.parse(readFileSync(join(repoRoot, "apps", "tui", "package.json"), "utf8")).version;
const port = Number(process.env.PORT || 4173);
const host = "127.0.0.1";

function loadThemes() {
  return readdirSync(themesDir)
    .filter((file) => /^felan-(?:light|dark)\.json$/u.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const theme = JSON.parse(readFileSync(join(themesDir, file), "utf8"));
      return { file, ...theme };
    });
}

function resolveColor(theme, token, fallback = "#ffffff") {
  if (!token) return theme.vars?.fg || fallback;
  if (typeof token === "string" && token.startsWith("#")) return token;
  return theme.vars?.[token] || fallback;
}

function enrichTheme(theme) {
  const c = theme.colors || {};
  return {
    ...theme,
    resolved: {
      bg: theme.export?.pageBg || theme.vars?.bg || "#111111",
      fg: theme.vars?.fg || "#eeeeee",
      panel: theme.vars?.panel || theme.export?.cardBg || theme.vars?.bg || "#181818",
      panelAlt: theme.vars?.panelAlt || theme.export?.infoBg || theme.vars?.bg || "#202020",
      accent: resolveColor(theme, c.accent, theme.vars?.accent || "#ffd166"),
      border: resolveColor(theme, c.border, theme.vars?.gray || "#666666"),
      borderMuted: resolveColor(theme, c.borderMuted, theme.vars?.gray || "#666666"),
      mdHr: resolveColor(theme, c.mdHr, theme.vars?.gray || "#666666"),
      muted: resolveColor(theme, c.muted, theme.vars?.gray || "#888888"),
      success: resolveColor(theme, c.success, theme.vars?.success || "#70e000"),
      error: resolveColor(theme, c.error, theme.vars?.error || "#ff5c8a"),
      warning: resolveColor(theme, c.warning, theme.vars?.warning || "#ffd166"),
      secondary: theme.vars?.secondary || resolveColor(theme, c.mdLink, "#80bfff"),
      mdHeading: resolveColor(theme, c.mdHeading, theme.vars?.white || theme.vars?.fg || "#ffffff"),
      mdCode: resolveColor(theme, c.mdCode, theme.vars?.accent || "#ffd166"),
      syntaxComment: resolveColor(theme, c.syntaxComment, theme.vars?.gray || "#888888"),
      syntaxKeyword: resolveColor(theme, c.syntaxKeyword, theme.vars?.accent || "#ffd166"),
      syntaxFunction: resolveColor(theme, c.syntaxFunction, theme.vars?.secondary || "#80bfff"),
      syntaxString: resolveColor(theme, c.syntaxString, theme.vars?.success || "#70e000"),
      syntaxNumber: resolveColor(theme, c.syntaxNumber, theme.vars?.warning || "#ffd166"),
      syntaxOperator: resolveColor(theme, c.syntaxOperator, theme.vars?.error || "#ff5c8a"),
      diffAdded: resolveColor(theme, c.toolDiffAdded, theme.vars?.success || "#70e000"),
      diffRemoved: resolveColor(theme, c.toolDiffRemoved, theme.vars?.error || "#ff5c8a"),
      diffContext: resolveColor(theme, c.toolDiffContext, theme.vars?.fg || "#eeeeee"),
      selectedBg: resolveColor(theme, c.selectedBg, theme.vars?.panelInfo || theme.vars?.panelAlt || "#202020"),
      userMessageBg: resolveColor(theme, c.userMessageBg, theme.vars?.panel || "#181818"),
      userMessageText: resolveColor(theme, c.userMessageText, theme.vars?.fg || "#eeeeee"),
      customMessageBg: resolveColor(theme, c.customMessageBg, theme.vars?.panelAlt || "#202020"),
      customMessageText: resolveColor(theme, c.customMessageText, theme.vars?.fg || "#eeeeee"),
      customMessageLabel: resolveColor(theme, c.customMessageLabel, theme.vars?.accent || "#ffd166"),
      toolPendingBg: resolveColor(theme, c.toolPendingBg, theme.vars?.panelAlt || "#202020"),
      toolSuccessBg: resolveColor(theme, c.toolSuccessBg, theme.vars?.panelSuccess || theme.vars?.panel || "#182218"),
      toolErrorBg: resolveColor(theme, c.toolErrorBg, theme.vars?.panelError || theme.vars?.panel || "#221818"),
      toolTitle: resolveColor(theme, c.toolTitle, theme.vars?.white || theme.vars?.fg || "#ffffff"),
      toolOutput: resolveColor(theme, c.toolOutput, theme.vars?.fg || "#eeeeee"),
    },
  };
}

const themes = loadThemes().map(enrichTheme);

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Felan Pi themes preview</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: #111; color: #eee; }
    .app { display: grid; grid-template-columns: 310px 1fr; min-height: 100vh; }
    aside { border-right: 1px solid #333; background: #151515; padding: 14px; position: sticky; top: 0; height: 100vh; overflow: auto; }
    h1 { font-size: 16px; margin: 0 0 12px; }
    input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #444; background: #0f0f0f; color: #fff; margin-bottom: 10px; }
    .hint { color: #aaa; font-size: 12px; line-height: 1.4; margin-bottom: 10px; }
    .theme-list { display: grid; gap: 6px; }
    .theme-btn { text-align: left; padding: 8px; border: 1px solid #333; border-radius: 10px; background: #202020; color: #ddd; cursor: pointer; display: grid; gap: 6px; }
    .theme-btn:hover, .theme-btn.active { border-color: var(--accent, #ffd166); outline: 1px solid var(--accent, #ffd166); }
    .swatches { display: flex; gap: 4px; }
    .swatch { width: 18px; height: 12px; border-radius: 3px; border: 1px solid rgba(255,255,255,.15); }
    main { background: #111; color: #eee; padding: 28px; transition: background .12s, color .12s; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 18px; }
    .title { margin: 0; color: #eee; font-size: 30px; }
    .sub { color: #aaa; margin-top: 4px; }
    .copy { border: 1px solid #444; background: #202020; color: #eee; padding: 9px 12px; border-radius: 10px; cursor: pointer; text-align: center; white-space: nowrap; transition: border-color .12s, background .12s, color .12s, transform .12s; }
    .copy:hover, .copy.copied { border-color: var(--accent, #ffd166); color: #fff; }
    .copy.copied { background: var(--selectedBg); transform: translateY(-1px); }
    .toast { position: fixed; right: 24px; bottom: 24px; z-index: 10; max-width: min(360px, calc(100vw - 48px)); padding: 12px 14px; border: 1px solid var(--accent, #ffd166); border-radius: 12px; background: var(--panel); color: var(--fg, #eee); box-shadow: 0 16px 42px rgba(0,0,0,.42); opacity: 0; transform: translateY(10px); pointer-events: none; transition: opacity .18s, transform .18s; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(320px, 1fr)); gap: 16px; }
    .wide { grid-column: 1 / -1; }
    .card { background: #151515; border: 1px solid #333; border-radius: 16px; padding: 16px; box-shadow: 0 16px 40px rgba(0,0,0,.22); }
    .card.alt { background: #202020; }
    .card h2 { color: #eee; margin: 0 0 12px; font-size: 18px; }
    .message { border-left: 4px solid var(--accent); padding: 10px 12px; background: var(--panelAlt); border-radius: 8px; margin: 10px 0; }
    .success { color: var(--success); } .error { color: var(--error); } .warning { color: var(--warning); } .muted { color: var(--muted); }
    pre { margin: 0; overflow: auto; padding: 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); line-height: 1.45; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .kw { color: var(--kw); } .fn { color: var(--fn); } .str { color: var(--str); } .num { color: var(--num); } .op { color: var(--op); } .com { color: var(--comment); }
    .palette-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .palette-head h2 { margin: 0; }
    .palette-toggle, .palette-summary { display: none; }
    .palette { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 8px; width: 100%; }
    .color { min-width: 0; border: 1px solid #333; border-radius: 10px; overflow: hidden; background: #202020; }
    .chip { height: 38px; }
    .label { padding: 7px; font-size: 10px; color: #aaa; overflow-wrap: anywhere; }
    .diff div { padding: 3px 8px; font-family: ui-monospace, monospace; border-radius: 4px; margin: 2px 0; }
    .add { color: var(--diffAdded); background: var(--toolSuccessBg); }
    .del { color: var(--diffRemoved); background: var(--toolErrorBg); }
    .ctx { color: var(--diffContext); }
    .pi-terminal { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; box-shadow: 0 24px 80px rgba(0,0,0,.5); }
    .pi-body { min-height: 760px; background: var(--bg); color: var(--fg); font-size: 13px; line-height: 1.42; overflow: auto; }
    .term-top { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0 10px 10px 0; color: var(--fg); white-space: nowrap; }
    .term-segment { color: inherit; font-weight: 400; }
    .term-status { color: var(--accent); }
    .term-content { padding: 10px 10px 0; min-width: 980px; }
    .term-line { white-space: pre-wrap; min-height: 1.42em; }
    .term-blank { height: 1.42em; }
    .term-dim { color: var(--muted); } .term-green { color: var(--success); } .term-red { color: var(--error); } .term-yellow { color: var(--warning); } .term-blue { color: var(--fn); } .term-accent { color: var(--accent); } .term-bold { color: var(--heading); font-weight: 700; }
    .term-rule { height: 1px; background: var(--mdHr); margin: 11px 0 9px; }
    .term-input { margin: 14px -9px 14px; padding: 14px 10px; background: var(--userBg); color: var(--userText); }
    .md-heading { color: var(--heading); font-weight: 800; }
    .fence { color: var(--accent); }
    .diff-add { color: var(--diffAdded); } .diff-del { color: var(--diffRemoved); }
    .note-line { color: var(--accent); font-style: italic; }
    .felan-footer { margin-top: 22px; color: var(--muted); }
    .felan-editor { height: 42px; border: 1px solid var(--borderMuted); padding: 11px 8px; background: transparent; }
    .powerline-row { display: flex; justify-content: space-between; gap: 16px; min-height: 24px; overflow: hidden; }
    .powerline-group { display: flex; min-width: 0; }
    .powerline-segment { display: inline-block; min-width: 0; padding: 3px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .powerline-directory { color: var(--accent); background: var(--customBg); }
    .powerline-git { color: var(--fg); background: var(--customBg); }
    .powerline-savings { color: var(--accent); background: var(--customBg); }
    .powerline-subscription, .powerline-context, .powerline-model { color: var(--muted); background: var(--customBg); }
    .powerline-status { color: var(--muted); background: var(--customBg); }
    .pi-cursor { display: inline-block; width: 9px; height: 1.15em; background: var(--fg); vertical-align: -2px; margin-left: 2px; animation: blink 1.05s steps(1) infinite; }
    .mobile-controls { display: none; }
    @keyframes blink { 50% { opacity: .12; } }
    @media (max-width: 900px) {
      body { overflow-x: hidden; }
      .app { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid #333; padding: 12px 14px; }
      aside input, aside .hint, aside .theme-list { display: none; }
      aside h1 { margin: 0; }
      main { padding: 16px 14px calc(92px + env(safe-area-inset-bottom)); overflow-x: hidden; }
      .topbar { align-items: start; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
      .title { font-size: 26px; line-height: 1.1; }
      .copy { padding: 8px 10px; font-size: 12px; }
      .grid { grid-template-columns: 1fr; gap: 12px; }
      .wide { grid-column: auto; }
      .card { border-radius: 14px; padding: 12px; }
      .palette-head { margin-bottom: 8px; }
      .palette-toggle { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 0 10px; border: 1px solid #444; border-radius: 999px; background: #202020; color: #eee; font: inherit; font-size: 12px; }
      .palette-summary { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 4px; width: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; }
      .palette-summary-chip { height: 22px; min-width: 0; border: 1px solid rgba(255,255,255,.16); border-radius: 6px; }
      .palette-details { display: none; margin-top: 10px; }
      .palette-card.expanded .palette-details { display: grid; }
      .palette { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
      .chip { height: 34px; }
      .label { padding: 6px; font-size: 9px; }
      .pi-body { min-height: 700px; overflow-x: hidden; font-size: 12px; }
      .term-top { align-items: start; white-space: normal; }
      .term-content { min-width: 0; width: 100%; }
      .term-line { overflow-wrap: anywhere; word-break: break-word; }
      .term-input { margin-left: 0; margin-right: 0; }
      .powerline-row { align-items: flex-start; flex-direction: column; gap: 2px; margin-top: 2px; }
      .powerline-group { flex-wrap: wrap; }
      .mobile-controls { display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; align-items: center; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid rgba(255,255,255,.16); background: rgba(18,18,18,.92); backdrop-filter: blur(14px); box-shadow: 0 -14px 36px rgba(0,0,0,.42); }
      .mobile-controls button, .mobile-controls select { min-height: 44px; border: 1px solid #444; border-radius: 12px; background: #202020; color: #eee; font: inherit; }
      .mobile-controls button { flex: 0 0 44px; font-size: 22px; line-height: 1; }
      .mobile-controls select { flex: 1 1 auto; min-width: 0; padding: 0 12px; overflow: hidden; text-overflow: ellipsis; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <h1>Felan Pi themes</h1>
      <input id="search" placeholder="Search themes..." autofocus />
      <div class="hint"><span id="count"></span> themes. Use ↑/↓ to switch, Enter to copy the selected theme path.</div>
      <div id="list" class="theme-list"></div>
    </aside>
    <main id="preview"></main>
  </div>
  <div id="mobileControls" class="mobile-controls" aria-label="Theme controls">
    <button id="prevTheme" type="button" aria-label="Previous theme">‹</button>
    <select id="themeSelect" aria-label="Select theme"></select>
    <button id="nextTheme" type="button" aria-label="Next theme">›</button>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
const themes = __THEMES__;
let selected = 0;
let filtered = themes.slice();
const themeFromHash = () => decodeURIComponent(window.location.hash.replace(/^#/, ""));
const indexByThemeName = (name) => themes.findIndex((t) => t.name === name);
const list = document.querySelector('#list');
const search = document.querySelector('#search');
const preview = document.querySelector('#preview');
const count = document.querySelector('#count');
const toast = document.querySelector('#toast');
const themeSelect = document.querySelector('#themeSelect');
const prevTheme = document.querySelector('#prevTheme');
const nextTheme = document.querySelector('#nextTheme');
let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

async function copyInstallCommand(t, button) {
  try {
    await navigator.clipboard.writeText(installCommand(t));
    showToast('Theme path copied to clipboard.');
    if (!button) return;
    const originalText = button.textContent;
    button.textContent = 'Copied ✓';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1600);
  } catch {
    showToast('Unable to copy automatically. Please copy the path manually.');
  }
}

function setVars(t) {
  const r = t.resolved;
  for (const [k, v] of Object.entries({
    bg:r.bg, fg:r.fg, panel:r.panel, panelAlt:r.panelAlt, accent:r.accent, border:r.border, muted:r.muted,
    success:r.success, error:r.error, warning:r.warning, heading:r.mdHeading, code:r.mdCode, kw:r.syntaxKeyword, fn:r.syntaxFunction,
    str:r.syntaxString, num:r.syntaxNumber, op:r.syntaxOperator, comment:r.syntaxComment, diffAdded:r.diffAdded,
    diffRemoved:r.diffRemoved, diffContext:r.diffContext, selectedBg:r.selectedBg, userBg:r.userMessageBg, userText:r.userMessageText,
    customBg:r.customMessageBg, customText:r.customMessageText, customLabel:r.customMessageLabel, toolBg:r.toolPendingBg,
    toolSuccessBg:r.toolSuccessBg, toolErrorBg:r.toolErrorBg, toolTitle:r.toolTitle, toolOutput:r.toolOutput,
    mdHr:r.mdHr, borderMuted:r.borderMuted
  })) preview.style.setProperty('--' + k, v);
}
function renderList() {
  count.textContent = filtered.length;
  list.innerHTML = filtered.map((t, i) => '<button class="theme-btn '+(i===selected?'active':'')+'" data-i="'+i+'" style="--accent:'+t.resolved.accent+'"><b>'+t.name+'</b><div class="swatches">'+
    ['bg','fg','accent','secondary','success','warning','error'].map(k => '<span class="swatch" style="background:'+ (t.resolved[k] || t.vars[k]) +'"></span>').join('') +
    '</div></button>').join('');
  list.querySelectorAll('button').forEach(b => b.onclick = () => select(Number(b.dataset.i), true));
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}
function renderMobileControls(t) {
  if (!themeSelect) return;
  if (themeSelect.options.length !== themes.length) {
    themeSelect.innerHTML = themes.map((theme) => '<option value="' + theme.name + '">' + theme.name + '</option>').join('');
  }
  themeSelect.value = t.name;
}

function selectGlobal(index, updateHash = true) {
  filtered = themes.slice();
  search.value = "";
  select((index + themes.length) % themes.length, updateHash);
}

function selectGlobalOffset(delta) {
  const t = filtered[selected] || themes[0];
  const index = indexByThemeName(t.name);
  if (index !== -1) selectGlobal(index + delta, true);
}

function renderPreview() {
  const t = filtered[selected] || themes[0];
  if (!t) return;
  setVars(t);
  renderMobileControls(t);
  const vars = ['bg','fg','panel','panelAlt','accent','secondary','success','warning','error','muted','diffAdded','diffRemoved'];
  const terminalLines = [
    '<div class="term-top"><div><span class="term-segment">~/workspace/felan</span> felan</div><div class="term-status">✓  local  13:18:02</div></div>',
    '<div class="term-line"><span class="term-accent">◉  felan v__FELAN_VERSION__</span></div>',
    '<div class="term-line"><span class="term-dim">   inspect · plan · implement · review</span></div>',
    '<div class="term-line"><span class="term-dim">escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line">Felan can inspect, plan, implement, review, test, and document software.</div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="term-dim">Press ctrl+o for full startup help and loaded resources.</span></div>',
    '<div class="term-rule"></div>',
    '<div class="term-line"><span class="term-bold">Theme preview</span></div>',
    '<div class="term-line"><span class="term-dim">The browser fixture mirrors Felan transcript, editor, and Powerline structure.</span></div>',
    '<div class="term-line"><span class="term-dim">The terminal emulator still owns the unpainted canvas.</span></div>',
    '<div class="term-rule"></div>',
    '<div class="term-input">Review the Felan themes against the design system and actual TUI.</div>',
    '<div class="term-line"><span class="term-dim">Thinking</span></div>',
    '<div class="term-line"><span class="term-dim">  · Inspecting semantic roles and terminal contrast.</span></div>',
    '<div class="term-line"><span class="term-dim">  · Comparing the browser fixture with grouped transcript output.</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="term-green">✓</span> <span class="term-bold">Read 3 files</span> <span class="term-dim">· 24ms</span></div>',
    '<div class="term-line"><span class="term-dim">  ✓ Read · apps/tui/src/themes/' + t.file + '</span></div>',
    '<div class="term-line"><span class="term-dim">  ✓ Read · packages/ext-powerline/src/footer.ts</span></div>',
    '<div class="term-line"><span class="term-green">✓</span> <span class="term-bold">Updated 1 file</span> <span class="term-dim">· 8ms</span></div>',
    '<div class="term-line"><span class="term-dim">  ✓ apply_patch · apps/tui/src/themes/' + t.file + '</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line">The active Pi theme is <span class="term-accent">' + t.name + '</span>. The following output exercises its real semantic roles.</div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### JavaScript syntax highlighting</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="fence">\`\`\`js</span></div>',
    '<div class="term-line">  <span class="kw">function</span> <span class="fn">greet</span>(name) {</div>',
    '<div class="term-line">    <span class="kw">const</span> message <span class="op">=</span> <span class="str">&#96;Hello, \${name}!&#96;</span>;</div>',
    '<div class="term-line">    console.<span class="fn">log</span>(message);</div>',
    '<div class="term-line">    <span class="kw">return</span> message;</div>',
    '<div class="term-line">  }</div>',
    '<div class="term-blank"></div>',
    '<div class="term-line">  <span class="fn">greet</span>(<span class="str">"Pi"</span>);</div>',
    '<div class="term-line"><span class="fence">\`\`\`</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### Python syntax highlighting</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="fence">\`\`\`python</span></div>',
    '<div class="term-line">  <span class="kw">from</span> dataclasses <span class="kw">import</span> dataclass</div>',
    '<div class="term-blank"></div>',
    '<div class="term-line">  <span class="term-accent">@dataclass</span></div>',
    '<div class="term-line">  <span class="kw">class</span> <span class="fn">Theme</span>:</div>',
    '<div class="term-line">      name: str</div>',
    '<div class="term-line">      dark: bool <span class="op">=</span> <span class="kw">True</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line">  theme <span class="op">=</span> <span class="fn">Theme</span>(name<span class="op">=</span><span class="str">"' + t.name + '"</span>)</div>',
    '<div class="term-line">  <span class="fn">print</span>(theme)</div>',
    '<div class="term-line"><span class="fence">\`\`\`</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### Shell commands</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="fence">\`\`\`bash</span></div>',
    '<div class="term-line">  pnpm theme:preview:check</div>',
    '<div class="term-line">  pnpm --filter @felan-ai/felan test</div>',
    '<div class="term-line"><span class="fence">\`\`\`</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### JSON block</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="fence">\`\`\`json</span></div>',
    '<div class="term-line">  {</div>',
    '<div class="term-line">    <span class="str">"name"</span>: <span class="str">"' + t.name + '"</span>,</div>',
    '<div class="term-line">    <span class="str">"type"</span>: <span class="str">"' + (t.name.endsWith('light') ? 'light' : 'dark') + '"</span>,</div>',
    '<div class="term-line">    <span class="str">"colors"</span>: {</div>',
    '<div class="term-line">      <span class="str">"background"</span>: <span class="str">"' + t.resolved.bg + '"</span>,</div>',
    '<div class="term-line">      <span class="str">"foreground"</span>: <span class="str">"' + t.resolved.fg + '"</span></div>',
    '<div class="term-line">    }</div>',
    '<div class="term-line">  }</div>',
    '<div class="term-line"><span class="fence">\`\`\`</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### Code diff</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="fence">\`\`\`diff</span></div>',
    '<div class="term-line diff-del">  - const themeName = "old-theme";</div>',
    '<div class="term-line diff-add">  + const themeName = "' + t.name + '";</div>',
    '<div class="term-blank"></div>',
    '<div class="term-line diff-del">  - console.log("invalid");</div>',
    '<div class="term-line diff-add">  + console.log("validated");</div>',
    '<div class="term-line"><span class="fence">\`\`\`</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### Plain text block</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="fence">\`\`\`text</span></div>',
    '<div class="term-line">  Validation complete.</div>',
    '<div class="term-line">  All theme files are valid.</div>',
    '<div class="term-line">  No changes required.</div>',
    '<div class="term-line"><span class="fence">\`\`\`</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### Warning / note style</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="note-line">│ Note: Pi themes color semantic content; the terminal emulator owns the base canvas.</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="md-heading">### Checklist</span></div>',
    '<div class="term-blank"></div>',
    '<div class="term-line"><span class="term-accent">- [x]</span> Read relevant files</div>',
    '<div class="term-line"><span class="term-accent">- [x]</span> Make precise edits</div>',
    '<div class="term-line"><span class="term-accent">- [x]</span> Run validation</div>',
    '<div class="term-line"><span class="term-accent">- [ ]</span> Commit changes if requested</div>',
    '<div class="felan-footer">',
    '<div class="felan-editor"><span class="pi-cursor"></span></div>',
    '<div class="powerline-row"><div class="powerline-group"><span class="powerline-segment powerline-directory">~/w/felan</span><span class="powerline-segment powerline-git">main +4</span></div><span class="powerline-segment powerline-savings">Est. Savings(7d): $33.00</span></div>',
    '<div class="powerline-row"><div class="powerline-group"><span class="powerline-segment powerline-context">ctx 42%</span><span class="powerline-segment powerline-session">$0.021</span><span class="powerline-segment powerline-subscription">sub 9%</span></div><span class="powerline-segment powerline-model">(anthropic) claude-sonnet · medium</span></div>',
    '<div class="powerline-row"><span class="powerline-segment powerline-status">Tasks 1 · 1 · 3</span></div>',
    '</div>'
  ];
  preview.innerHTML = [
    '<div class="topbar"><div><h1 class="title">' + t.name + '</h1><div class="sub">' + t.file + '</div></div><button class="copy" id="copy">Copy theme path</button></div>',
    '<div class="grid">',
    '<section class="card wide palette-card"><div class="palette-head"><h2>Palette</h2><button class="palette-toggle" id="paletteToggle" type="button" aria-expanded="false" aria-controls="paletteDetails">Show details</button></div><button class="palette-summary" id="paletteSummary" type="button" aria-label="Show palette details">' + vars.map(k => '<span class="palette-summary-chip" style="background:' + (t.resolved[k] || t.vars[k]) + '"></span>').join('') + '</button><div class="palette palette-details" id="paletteDetails">' + vars.map(k => '<div class="color"><div class="chip" style="background:' + (t.resolved[k] || t.vars[k]) + '"></div><div class="label">' + k + '<br>' + (t.resolved[k] || t.vars[k]) + '</div></div>').join('') + '</div></section>',
    '<section class="card wide"><h2>Terminal</h2><div class="pi-terminal"><div class="pi-body"><div class="term-content">' + terminalLines.join('') + '</div></div></div></section>',
    '</div>'
  ].join('');
  const copyButton = document.querySelector('#copy');
  copyButton.style.inlineSize = copyButton.offsetWidth + 'px';
  copyButton.onclick = async (event) => copyInstallCommand(t, event.currentTarget);
  const paletteCard = document.querySelector('.palette-card');
  const paletteToggle = document.querySelector('#paletteToggle');
  const paletteSummary = document.querySelector('#paletteSummary');
  function togglePalette() {
    const expanded = paletteCard.classList.toggle('expanded');
    paletteToggle.setAttribute('aria-expanded', String(expanded));
    paletteToggle.textContent = expanded ? 'Hide details' : 'Show details';
    paletteSummary.setAttribute('aria-label', expanded ? 'Hide palette details' : 'Show palette details');
  }
  paletteToggle.onclick = togglePalette;
  paletteSummary.onclick = togglePalette;
}
function installCommand(t) { return 'apps/tui/src/themes/' + t.file; }
function select(i, updateHash = false) {
  selected = Math.max(0, Math.min(i, filtered.length - 1));
  renderList();
  renderPreview();
  if (updateHash) {
    const t = filtered[selected];
    if (t) history.replaceState(null, "", "#" + encodeURIComponent(t.name));
  }
}
function selectHashTheme() {
  const hashTheme = themeFromHash();
  const index = indexByThemeName(hashTheme);
  if (index !== -1) {
    filtered = themes.slice();
    search.value = "";
    selected = index;
  }
}
search.oninput = () => { const q = search.value.toLowerCase(); filtered = themes.filter(t => t.name.toLowerCase().includes(q)); selected = 0; renderList(); renderPreview(); };
themeSelect.onchange = () => { const index = indexByThemeName(themeSelect.value); if (index !== -1) selectGlobal(index, true); };
prevTheme.onclick = () => selectGlobalOffset(-1);
nextTheme.onclick = () => selectGlobalOffset(1);
document.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1, true); } if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1, true); } if (e.key === 'Enter') { copyInstallCommand(filtered[selected] || themes[0]); } });
window.addEventListener('hashchange', () => { selectHashTheme(); renderList(); renderPreview(); });
selectHashTheme();
renderList(); renderPreview();
</script>
</body>
</html>`;

const page = html
  .replace("__THEMES__", JSON.stringify(themes).replaceAll("<", "\\u003c"))
  .replaceAll("__FELAN_VERSION__", felanVersion);

function buildStaticSite() {
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(pagesIndex, page, "utf8");
  console.log(`Static build ready: ${pagesIndex}`);
}

function servePreview() {
  const server = createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    });
    res.end(page);
  });

  server.listen(port, host, () => {
    console.log(`Web preview ready: http://${host}:${port}`);
    console.log("Open this URL in your browser. Press Ctrl+C to stop the server.");
  });
}

if (themes.length !== 2) {
  throw new Error(`Expected two Felan themes, found ${themes.length}`);
}

if (process.argv.includes("--build")) {
  buildStaticSite();
} else if (process.argv.includes("--check")) {
  if (html.includes('term-magenta') || html.includes('term-cyan') || html.includes('color-mix')) {
    throw new Error('Preview contains browser-only terminal color transformations');
  }
  if (!themes.some((theme) => theme.name === 'felan-dark' && theme.resolved.bg === theme.vars.bg)
    || !themes.some((theme) => theme.name === 'felan-light' && theme.resolved.bg === theme.vars.bg)) {
    throw new Error('Preview canvas does not follow the theme background');
  }
  console.log(`Validated Felan theme preview for ${themes.map((theme) => theme.name).join(" and ")}`);
} else {
  servePreview();
}
