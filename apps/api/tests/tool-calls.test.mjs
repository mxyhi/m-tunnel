import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { bashTool } from '../../../packages/workspace-tools/dist/index.js';

test('调用详情保存参数和结果，迁移旧记录并隔离工作区权限', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mtunnel-calls-test-'));
  const file = join(dir, 'test.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec('CREATE TABLE tool_calls (id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL, workspace TEXT, user_id TEXT, duration_ms INTEGER, error TEXT, created_at BIGINT NOT NULL)');
  legacy.prepare('INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-call', 'read', 'success', null, null, 1, null, 1);
  legacy.close();
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_URL: '', MCP_TOKEN: '', PORT: String(port), DB_FILE: file, ADMIN_EMAIL: 'qa@example.test', ADMIN_PASSWORD: 'test-password-local' }, stdio: 'ignore' });
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); child.kill(); if (child.exitCode === null) await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); });
  let started = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) { started = true; break; } } catch {} await delay(50); }
  assert.equal(started, true, 'API 启动');
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'qa@example.test', password: 'test-password-local' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (path, method = 'GET', body, session = cookie) => fetch(`${base}/api${path}`, { method, headers: { cookie: session, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const connection = await (await api('/connections', 'POST')).json();
  const mcp = (name, args = {}) => fetch(`${base}/mcp/${connection.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const toolList = await (await fetch(`${base}/mcp/${connection.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
  const timeoutSchema = toolList.result.tools.find(tool => tool.name === 'bash').inputSchema.properties.timeout;
  await mcp('workspace_info');
  const rows = await (await api('/tool-calls')).json();
  assert.equal(rows.length, 1);
  const detailResponse = await api(`/tool-calls/${rows[0].id}`);
  assert.equal(detailResponse.status, 200, '调用详情接口可访问');
  const detail = await detailResponse.json();
  assert.deepEqual(JSON.parse(detail.arguments), {});
  assert.equal(JSON.parse(detail.result).workspaceId, connection.workspaceId);
  assert.equal('arguments' in rows[0], false, '列表不携带调用正文');
  assert.equal('result' in rows[0], false);
  const old = await (await api('/tool-calls/legacy-call')).json();
  assert.equal(old.arguments, null, '旧记录没有伪造参数');
  assert.equal(old.result, null);
  assert.equal((await api('/tool-calls/missing')).status, 404);
  assert.equal((await api(`/tool-calls/${detail.id}`, 'GET', undefined, '')).status, 401);

  const ws = new WebSocket(`${base.replace('http', 'ws')}/agent/${connection.token}`); clients.push(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'agent_hello', name: '详情测试', workspace: '/tmp/detail', platform: 'darwin' }));
  await once(ws, 'message');
  const output = '输出第一行\n第二行\n' + '内容'.repeat(40000);
  const received = [];
  ws.on('message', async (raw) => {
    const call = JSON.parse(raw.toString());
    if (call.type !== 'tool_call') return;
    received.push(call.arguments);
    if (call.arguments.command === 'sleep 1.2; printf delayed') {
      try {
        const result = await bashTool({ cwd: dir }, call.arguments);
        ws.send(JSON.stringify({ type: 'tool_result', id: call.id, ok: true, content: result.content }));
      } catch (error) {
        ws.send(JSON.stringify({ type: 'tool_result', id: call.id, ok: false, content: error.message }));
      }
      return;
    }
    if (call.arguments.command === 'disconnect') { ws.close(); return; }
    const ok = call.arguments.command !== 'fail';
    ws.send(JSON.stringify({ type: 'tool_result', id: call.id, ok, content: ok ? (call.arguments.command === 'empty' ? '' : output) : '命令执行失败' }));
  });
  const args = { command: 'printf "你好\\n"', timeout: 120 };
  assert.equal((await mcp('bash', args)).status, 200);
  assert.equal(received.at(-1).timeout, 120000, 'MCP 超时以秒为单位，转发给插件时换算成毫秒');
  assert.equal(timeoutSchema.minimum, 1);
  assert.equal(timeoutSchema.maximum, 300);
  assert.match(timeoutSchema.description, /seconds/);
  for (const timeout of [0, -1, 301, 120000, '60', null]) {
    const count = received.length;
    assert.equal((await mcp('bash', { command: 'invalid', timeout })).status, 400, '拒绝错误单位或非法超时');
    assert.equal(received.length, count, '非法超时不能触发执行');
  }
  assert.equal((await mcp('bash', args)).status, 200);
  let latest = (await (await api('/tool-calls')).json())[0];
  let call = await (await api(`/tool-calls/${latest.id}`)).json();
  assert.deepEqual(JSON.parse(call.arguments), args);
  assert.equal(call.result, output, '多行长输出完整保留');
  assert.equal(call.error, null);
  const slow = await (await mcp('bash', { command: 'sleep 1.2; printf delayed', timeout: 2 })).json();
  assert.equal(slow.result.isError, false, '超过 1 秒的真实命令不应被秒/毫秒混淆截断');
  assert.equal(slow.result.content[0].text, 'delayed');
  for (const command of ['empty', 'fail', 'disconnect', 'offline']) {
    await mcp('bash', { command });
    latest = (await (await api('/tool-calls')).json())[0];
    call = await (await api(`/tool-calls/${latest.id}`)).json();
    assert.deepEqual(JSON.parse(call.arguments), { command });
    assert.equal(call.status, command === 'empty' ? 'success' : 'error');
    if (command === 'empty') assert.equal(call.result, '', '空输出和未记录不同');
    if (command === 'empty') assert.equal('timeout' in received.at(-1), false, '省略超时继续使用插件配置');
    else assert.ok(call.error);
    if (command === 'fail') assert.equal(call.result, '命令执行失败');
    if (command === 'disconnect' || command === 'offline') assert.equal(call.result, null);
  }

  const registered = await api('/auth/register', 'POST', { email: 'member@example.test', password: 'member-password' });
  assert.equal(registered.status, 201);
  const member = await registered.json();
  const memberLogin = await api('/auth/login', 'POST', { email: 'member@example.test', password: 'member-password' });
  const memberCookie = memberLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await api(`/tool-calls/${detail.id}`, 'GET', undefined, memberCookie)).status, 403);
  assert.deepEqual(await (await api('/tool-calls', 'GET', undefined, memberCookie)).json(), []);
  await api(`/workspaces/${connection.workspaceId}/members/${member.id}`, 'PUT', { role: 'viewer' });
  assert.equal((await api(`/tool-calls/${detail.id}`, 'GET', undefined, memberCookie)).status, 200);

  // 详情按 ID 查询，不能因列表只保留最近 100 条而失效。
  const seed = new DatabaseSync(file);
  const insert = seed.prepare('INSERT INTO tool_calls (id, tool, status, workspace, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 101; i++) insert.run(`newer-${i}`, 'read', 'success', connection.workspaceId, Date.now() + i + 1000);
  seed.close();
  assert.equal((await (await api('/tool-calls')).json()).some(row => row.id === detail.id), false);
  assert.equal((await api(`/tool-calls/${detail.id}`)).status, 200);
});
