const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const Module = require('node:module');

test('扩展派发新工具，机器配置优先且仓库设置不能增加读取根', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mtunnel-extension-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'); const external = join(dir, 'external');
  await mkdir(project); await mkdir(external);
  await writeFile(join(project, 'AGENTS.md'), 'project rules');
  await writeFile(join(external, 'note.txt'), 'external content');
  let globalValue = [external];
  const vscode = { workspace: { isTrusted: true, getConfiguration: () => ({ inspect: () => ({ globalValue, defaultValue: [], workspaceValue: [external] }) }) } };
  const originalLoad = Module._load;
  Module._load = function (id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
  let execute;
  try { ({ execute } = require('../dist/extension.js')); }
  finally { Module._load = originalLoad; }
  const root = { uri: { fsPath: project } };
  assert.equal((await execute(root, 'read_context', { path: join(external, 'note.txt') })).content, 'external content');
  const manifest = JSON.parse((await execute(root, 'context_manifest', {})).content);
  assert.equal(manifest.agents[0].path, join(project, 'AGENTS.md'));
  globalValue = [];
  await assert.rejects(execute(root, 'read_context', { path: join(external, 'note.txt') }), /允许的目录/);
  await assert.rejects(execute(root, 'read_context', { path: 'AGENTS.md', offset: '1' }), /数字/);
  await assert.rejects(execute(root, 'context_manifest', { path: false }), /string/);
  await assert.rejects(execute(root, 'future_tool', {}), /不支持/);
  vscode.workspace.isTrusted = false;
  await assert.rejects(execute(root, 'context_manifest', {}), /信任/);
});
