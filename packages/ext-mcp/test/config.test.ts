import { describe, expect, it } from 'vitest';
import { resolveMcpServers, validateMcpConfig } from '../src/config.js';

describe('MCP config boundary', () => {
  it('clones and resolves explicit OAuth HTTP servers', () => {
    const input = {
      mcpServers: {
        notion: {
          url: 'https://mcp.example.test/mcp',
          auth: 'oauth',
          transport: 'streamable-http',
        },
      },
      settings: { requestTimeoutMs: 12_000 },
    };
    const config = validateMcpConfig(input);
    input.mcpServers.notion.url = 'https://changed.example.test';

    expect(config).toEqual({
      mcpServers: {
        notion: {
          url: 'https://mcp.example.test/mcp',
          auth: 'oauth',
          transport: 'streamable-http',
        },
      },
      settings: { requestTimeoutMs: 12_000 },
    });
    expect(resolveMcpServers(config)).toEqual([{
      name: 'notion',
      url: 'https://mcp.example.test/mcp',
      auth: 'oauth',
      transport: 'streamable-http',
      requestTimeoutMs: 12_000,
    }]);
  });

  it.each([
    [{ mcpServers: { bad: { url: 'https://mcp.test' } } }, 'explicitly'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'bearer' } } }, 'explicitly'],
    [{ mcpServers: { bad: { command: 'npx', auth: 'oauth' } } }, 'unknown field'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'oauth', oauth: {} } } }, 'unknown field'],
    [{ mcpServers: { bad: { url: 'file:///tmp/mcp', auth: 'oauth' } } }, 'HTTPS'],
    [{ mcpServers: { bad: { url: 'https://user:pass@mcp.test', auth: 'oauth' } } }, 'credentials'],
  ])('rejects unsupported config %#', (value, message) => {
    expect(() => validateMcpConfig(value)).toThrow(message);
  });

  it('allows HTTP only for explicit loopback development endpoints', () => {
    expect(validateMcpConfig({
      mcpServers: { local: { url: 'http://127.0.0.1:3000/mcp', auth: 'oauth' } },
    }).mcpServers.local?.url).toBe('http://127.0.0.1:3000/mcp');
    expect(() => validateMcpConfig({
      mcpServers: { remote: { url: 'http://example.test/mcp', auth: 'oauth' } },
    })).toThrow('HTTPS');
  });
});
