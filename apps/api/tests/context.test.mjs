import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { contextManifest, readContext } from '../../../packages/workspace-tools/dist/index.js';

test('上下文 MCP 链路：实际发现与读取、旧插件拒绝、viewer 隔离及所有分支的记录脱敏', { timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mtunnel-context-api-'));
  const file = join(dir, 'test.sqlite');
  const options = { cwd: join(dir, 'project'), home: join(dir, 'home') };
  await mkdir(options.cwd); await mkdir(join(options.home, '.codex'), { recursive: true });
  await writeFile(join(options.cwd, 'AGENTS.md'), 'PROJECT_CONTEXT_PRIVATE');
  await writeFile(join(options.home, '.codex/AGENTS.md'), 'GLOBAL_CONTEXT_PRIVATE');
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATABASE_URL: '', MCP_TOKEN: '', PORT: String(port), DB_FILE: file, ADMIN_EMAIL: 'qa@example.test', ADMIN_PASSWORD: 'local-context-test' }, stdio: 'ignore' });
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); child.kill(); if (child.exitCode === null) await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); });
  let started = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) { started = true; break; } } catch {} await delay(50); }
  assert.equal(started, true);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'qa@example.test', password: 'local-context-test' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (path, method = 'GET') => fetch(`${base}/api${path}`, { method, headers: { cookie } });
  const connection = await (await api('/connections', 'POST')).json();
  const rpc = (method, params = {}, token = connection.token) => fetch(`${base}/mcp/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const call = (name, args = {}, token) => rpc('tools/call', { name, arguments: args }, token);
  const tools = ['read', 'bash', 'edit', 'write', 'context_manifest', 'read_context'];
  const connect = async (capabilities) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/agent/${connection.token}`); clients.push(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'agent_hello', name: 'context-test', workspace: options.cwd, platform: process.platform, ...(capabilities ? { tools: capabilities } : {}) }));
    await once(ws, 'message'); return ws;
  };
  const legacy = await connect();
  let received = 0;
  legacy.on('message', (raw) => { const request = JSON.parse(raw.toString()); received++; legacy.send(JSON.stringify({ type: 'tool_result', id: request.id, ok: true, content: 'legacy-ok' })); });
  for (const name of ['context_manifest', 'read_context']) {
    const response = await call(name, { path: 'PRIVATE_ARGUMENT' });
    assert.equal(response.status, 502); assert.match((await response.json()).error.message, /更新/);
  }
  assert.equal(received, 0, '不把新工具发给旧插件等待超时');
  assert.equal((await (await call('read', { path: 'AGENTS.md' })).json()).result.content[0].text, 'legacy-ok');
  const current = await connect(tools);
  current.on('message', async (raw) => {
    const request = JSON.parse(raw.toString()); received++;
    if (request.arguments.path === 'disconnect') { current.close(); return; }
    try {
      if (request.arguments.path === 'error') throw new Error('PRIVATE_ERROR_WITH_BODY');
      const content = request.tool === 'context_manifest' ? JSON.stringify(await contextManifest(options, request.arguments)) : (await readContext(options, request.arguments)).content;
      current.send(JSON.stringify({ type: 'tool_result', id: request.id, ok: true, content }));
    } catch (error) { current.send(JSON.stringify({ type: 'tool_result', id: request.id, ok: false, content: error.message })); }
  });
  const initialized = await (await rpc('initialize')).json();
  assert.match(initialized.result.instructions, /context_manifest/);
  const listed = (await (await rpc('tools/list')).json()).result.tools;
  assert.ok(listed.find((tool) => tool.name === 'context_manifest'));
  assert.equal(listed.find((tool) => tool.name === 'read_context').inputSchema.properties.limit.maximum, 1000);
  const manifestReply = (await (await call('context_manifest', { path: 'new.ts' })).json()).result;
  assert.equal(manifestReply.isError, false);
  const manifest = JSON.parse(manifestReply.content[0].text);
  assert.deepEqual(manifest.agents.map((entry) => entry.scope), ['global', 'project']);
  for (const entry of manifest.agents) {
    const reply = (await (await call('read_context', { path: entry.path })).json()).result;
    assert.equal(reply.isError, false); assert.match(reply.content[0].text, /CONTEXT_PRIVATE/);
  }
  assert.equal((await (await call('read_context', { path: 'error' })).json()).result.isError, true);

  const database = new DatabaseSync(file);
  const viewer = 'legacy-viewer-context-token';
  database.prepare('INSERT INTO workspace_tokens (id, workspace_id, token_hash, token_prefix, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('viewer', connection.workspaceId, createHash('sha256').update(viewer).digest('hex'), 'viewer', 'viewer', Date.now());
  const before = received;
  for (const name of ['context_manifest', 'read_context']) assert.equal((await call(name, { path: 'PRIVATE_ARGUMENT' }, viewer)).status, 403);
  assert.equal(received, before);
  assert.deepEqual((await (await rpc('tools/list', {}, viewer)).json()).result.tools.map((tool) => tool.name), ['read', 'workspace_info']);
  assert.doesNotMatch((await (await rpc('initialize', {}, viewer)).json()).result.instructions, /context_manifest|read_context/);
  assert.equal((await call('read_context', { path: 'disconnect' })).status, 502);
  assert.equal((await call('context_manifest')).status, 502);

  const rows = database.prepare("SELECT * FROM tool_calls WHERE tool IN ('context_manifest', 'read_context')").all();
  assert.equal(rows.length, 10);
  for (const row of rows) {
    assert.equal(row.arguments, null); assert.equal(row.result, null);
    assert.equal(row.error, row.status === 'error' ? '上下文调用失败；原文未保存' : null);
    const detail = await (await api(`/tool-calls/${row.id}`)).json();
    assert.equal(detail.arguments, null); assert.equal(detail.result, null);
  }
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
  database.close();
});
