import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('连接自动准备、文件夹登记、重连隔离、撤销和无只读新凭据', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mtunnel-api-test-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_URL: '', MCP_TOKEN: '', PORT: String(port), DB_FILE: join(dir, 'test.sqlite'), ADMIN_EMAIL: 'qa@example.test', ADMIN_PASSWORD: 'test-password-local' }, stdio: 'ignore' });
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); child.kill(); await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); });
  let started = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) { started = true; break; } } catch {} await delay(50); }
  assert.equal(started, true, 'API 启动');
  assert.equal((await fetch(`${base}/api/connections`, { method: 'POST' })).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'qa@example.test', password: 'test-password-local' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (path, method = 'GET', body) => fetch(`${base}/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.deepEqual(await (await api('/workspaces')).json(), [], '无须默认或手动创建工作区');
  const connection = await (await api('/connections', 'POST')).json();
  const path = `/workspaces/${connection.workspaceId}`;
  let workspaces = await (await api('/status')).json();
  assert.equal(workspaces.length, 1); assert.equal(workspaces[0].registeredAt, null); assert.equal(workspaces[0].agentConnected, false);
  assert.equal((await api(`${path}/tokens`, 'POST', { role: 'viewer' })).status, 422);
  const hello = { type: 'agent_hello', name: '自动登记文件夹', workspace: '/tmp/project', platform: 'darwin', bindingKey: 'machine:file:///tmp/project' };
  const socket = async (message) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/agent/${connection.token}`); clients.push(ws);
    await once(ws, 'open'); ws.send(JSON.stringify(message)); return ws;
  };
  const first = await socket(hello);
  const [raw] = await once(first, 'message');
  assert.deepEqual(JSON.parse(raw.toString()), { type: 'agent_ready', workspaceId: connection.workspaceId, name: hello.name });
  workspaces = await (await api('/status')).json();
  assert.equal(workspaces[0].name, hello.name); assert.equal(workspaces[0].workspacePath, hello.workspace); assert.equal(workspaces[0].agentConnected, true);
  const oldClosed = once(first, 'close');
  const second = await socket(hello); await once(second, 'message');
  assert.equal((await oldClosed)[0], 4009, '旧窗口停止抢连接');
  const wrong = await socket({ ...hello, bindingKey: 'other-folder', workspace: '/tmp/other' });
  assert.equal((await once(wrong, 'close'))[0], 4003, '不能把凭据用于另一文件夹');
  assert.equal(second.readyState, WebSocket.OPEN);
  second.on('message', (data) => { const request = JSON.parse(data.toString()); if (request.type === 'tool_call') second.send(JSON.stringify({ type: 'tool_result', id: request.id, ok: true, content: 'write allowed' })); });
  const mcp = await fetch(`${base}/mcp/${connection.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command: 'echo ok' } } }) });
  assert.equal(mcp.status, 200); assert.equal((await mcp.json()).result.isError, false);
  const revoked = once(second, 'close');
  assert.equal((await api(`${path}/tokens/${connection.id}`, 'DELETE')).status, 200);
  assert.equal((await revoked)[0], 4001, '撤销立即断开当前 Agent');
  assert.equal((await fetch(`${base}/mcp/${connection.token}`, { method: 'POST', body: '{}' })).status, 401);
  const disconnected = (await (await api('/status')).json())[0];
  assert.equal(disconnected.agentConnected, false); assert.equal(disconnected.workspacePath, hello.workspace, '离线保留文件夹信息');
  const tokens = await (await api(`${path}/tokens`)).json();
  assert.equal(tokens[0].role, 'editor'); assert.equal('token' in tokens[0], false);
});
