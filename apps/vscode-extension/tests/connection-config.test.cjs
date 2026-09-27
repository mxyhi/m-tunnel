const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseConnectionUri, validateConnection, mcpUrl } = require('../dist/connection-config.cjs');
const token = 'a'.repeat(64);

test('VS Code 导入 URI 与 MCP 链接使用相同凭据', () => {
  const config = parseConnectionUri(`vscode://mxyer.m-tunnel-vscode/connect?${new URLSearchParams({ relay: 'https://mtunnel.example', token })}`);
  assert.deepEqual(config, { relayUrl: 'https://mtunnel.example', token });
  assert.equal(mcpUrl(config), `https://mtunnel.example/mcp/${token}`);
});

test('拒绝错误扩展、重复凭据、危险服务地址和无效 Token', () => {
  assert.throws(() => parseConnectionUri(`vscode://other.extension/connect?relay=https://mtunnel.example&token=${token}`));
  assert.throws(() => parseConnectionUri(`vscode://mxyer.m-tunnel-vscode/connect?relay=https://mtunnel.example&token=${token}&token=${token}`));
  for (const relay of ['http://remote.example', 'https://user:password@example.com', 'file:///tmp/relay', 'https://example.com?secret=1', 'https://example.com/path']) assert.throws(() => validateConnection(relay, token));
  assert.throws(() => validateConnection('https://example.com', 'short'));
  assert.equal(validateConnection('http://127.0.0.1:18390', token).relayUrl, 'http://127.0.0.1:18390');
});
