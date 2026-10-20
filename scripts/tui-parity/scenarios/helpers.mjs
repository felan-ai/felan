export const settle = (timeoutMs = 15000) => ({ wait: { settle: true, timeoutMs } });
export const pause = ms => ms === undefined ? settle() : ({ wait: { ms } });
export const until = (text, timeoutMs = 30000) => ({ wait: { text, timeoutMs, onTimeout: 'observe' } });
export const idle = (timeoutMs = 60000) => ({ wait: { idle: true, timeoutMs } });
export const screen = checkpoint => ({ checkpoint });
export const keys = (...value) => ({ keys: value });
export const command = (text, selector) => [{ text }, keys('Enter'), ...(selector ? [until(selector)] : []), settle()];
export const esc = () => [keys('Escape'), settle()];
export const prompt = (text, name = 'response') => [{ prompt: text }, idle(), screen(name)];
export const legacyClientFallback = () => [
  ...command(`!!node -e 'const f=require("node:fs"),p=require("node:path"),a=process.env.FELAN_AGENT_DIR,c=p.resolve(a,"../client");if(f.existsSync(p.join(c,"tui/settings.json")))throw Error("Expected fresh client preferences");f.mkdirSync(c,{recursive:true,mode:448});f.copyFileSync(p.join(a,"settings.json"),p.join(c,"settings.json"));console.log("PARITY CLIENT LEGACY SEEDED");'`).map(step => ({ side: 'new', ...step })),
  { side: 'new', ...until('PARITY CLIENT LEGACY SEEDED') },
  ...command('/daemon restart', 'Restart daemon').map(step => ({ side: 'new', ...step })),
  { side: 'new', ...keys('Down', 'Enter') }, { side: 'new', ...pause(3000) }, { side: 'new', ...idle(30000) },
  screen('legacy-fallback-ready'),
];
export function scenario(id, title, steps, observe, intentional = [], paid = false) {
  return { id, area: id[0], title, steps, observe, intentional, ...(paid ? { paid } : {}) };
}
