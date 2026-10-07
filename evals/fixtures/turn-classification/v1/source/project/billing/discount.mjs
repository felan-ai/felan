export function discount(cents, vip) { return vip ? Math.floor(cents / 10) : 0; }
