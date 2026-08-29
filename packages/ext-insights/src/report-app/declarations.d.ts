declare module '*.svg' {
  const source: string;
  export default source;
}

declare global {
  interface Window {
    __FELAN_INSIGHTS_DATA__: import('../types.js').Analytics;
  }
}

export {};
