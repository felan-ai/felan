export type OpenBrowser = (url: string) => Promise<unknown>;

export const openInBrowser: OpenBrowser = async url => (await import('open')).default(url);
