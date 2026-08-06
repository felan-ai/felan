declare module 'promise.try' {
  interface PromiseTryModule {
    shim(): void;
  }

  const promiseTry: PromiseTryModule;
  export default promiseTry;
}
