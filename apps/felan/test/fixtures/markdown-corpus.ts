export const codeHeavyCorpus = {
  typescript: '# TypeScript\n\nUse `Promise<void>` for asynchronous work.\n\n```ts\nasync function run<T>(items: T[]): Promise<void> {\n  for (let i = 0; i < items.length; i++) {\n    if (i > 0) console.log(items[i]);\n  }\n}\n```\n\nDone.\n',
  go: '# Go\n\nTabs remain readable.\n\n```go\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tfmt.Println(i)\n\t}\n}\n```\n\nDone.\n',
  json: '# JSON\n\nAn array of objects:\n\n```json\n[\n  { "name": "first", "enabled": true },\n  { "name": "second", "enabled": false }\n]\n```\n\n[1, 2, 3]\n\nDone.\n',
  toml: '# TOML\n\nConfiguration:\n\n```toml\n[server]\nport = 3000\n\n[database]\nhost = "localhost"\n```\n\n[server]\nport = 3000\n\nDone.\n',
  jsx: '# JSX\n\nRender a component:\n\n```tsx\nconst view = <Panel>\n  <Button disabled={count < 1}>Save</Button>\n</Panel>;\n```\n\n<Panel>\n  <Button>Save</Button>\n</Panel>\n\nDone.\n',
  crlf: '# Windows\r\n\r\nUse `Promise<void>`.\r\n\r\n```go\r\nfunc main() {\r\n\tfmt.Println("hello")\r\n}\r\n```\r\n\r\nDone.\r\n',
  carriageReturns: '# Returns\r\rFirst.\r\r\tIndented code.\r\rLast.\r',
};
