export const settle = (timeoutMs = 15000) => ({ wait: { settle: true, timeoutMs } });
export const pause = ms => ms === undefined ? settle() : ({ wait: { ms } });
export const until = (text, timeoutMs = 30000) => ({ wait: { text, timeoutMs, onTimeout: 'observe' } });
export const idle = (timeoutMs = 60000) => ({ wait: { idle: true, timeoutMs } });
export const screen = checkpoint => ({ checkpoint });
export const keys = (...value) => ({ keys: value });
export const command = (text, selector) => [{ text }, keys('Enter'), ...(selector ? [until(selector)] : []), settle()];
export const esc = () => [keys('Escape'), settle()];
export const prompt = (text, name = 'response') => [{ prompt: text }, idle(), screen(name)];
export function scenario(id, title, steps, observe, intentional = [], paid = false) {
  return { id, area: id[0], title, steps, observe, intentional, ...(paid ? { paid } : {}) };
}
