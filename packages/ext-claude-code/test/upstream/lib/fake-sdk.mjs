export function fakeSdk() {
  return {
    query() {
      throw new Error('Unexpected Claude Agent SDK query: inject a test query first');
    },
    McpServer: class {
      handlers = new Map();
      server = {
        setRequestHandler: (schema, handler) => this.handlers.set(schema.method, handler),
      };
    },
    CallToolRequestSchema: { method: 'tools/call' },
    ListToolsRequestSchema: { method: 'tools/list' },
  };
}
