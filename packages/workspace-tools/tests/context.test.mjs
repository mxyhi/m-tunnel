import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { contextManifest, readContext, readTool, writeTool, editTool } from '../dist/index.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mtunnel-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { cwd: join(dir, 'project'), home: join(dir, 'home') };
  await mkdir(options.cwd); await mkdir(options.home);
  const put = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  return { dir, options, put, codex: join(options.home, '.codex'), agents: join(options.home, '.agents') };
}

test('全局二选一，项目根到目标逐层叠加，不加载兄弟目录或工作区外规则', async (t) => {
  const { dir, options, put, codex, agents } = await fixture(t);
  const project = options.cwd;
  await put(join(codex, 'AGENTS.md'), 'global-first');
  await put(join(agents, 'AGENTS.md'), 'global-fallback');
  const applicable = ['AGENTS.md', 'apps/AGENTS.md', 'apps/api/AGENTS.md', 'apps/api/src/AGENTS.md'];
  for (const path of applicable) await put(join(project, path), path);
  await put(join(project, 'apps/web/AGENTS.md'), 'unrelated');
  await put(join(dir, 'AGENTS.md'), 'outside');
  const manifest = await contextManifest(options, { path: 'apps/api/src/new.ts' });
  assert.deepEqual(manifest.agents.map((entry) => entry.path), [join(codex, 'AGENTS.md'), ...applicable.map((path) => join(project, path))]);
  assert.deepEqual(manifest.agents.map((entry) => entry.scope), ['global', 'project', 'project', 'project', 'project']);
  assert.equal(JSON.stringify(manifest).includes('global-first'), false, 'manifest 不含规则正文');
  assert.deepEqual((await contextManifest(options, { path: 'apps/api/src' })).agents, manifest.agents);
  await symlink(join(project, 'apps/api/src'), join(project, 'alias'), 'dir');
  const aliased = await contextManifest(options, { path: 'alias/new.ts' });
  assert.deepEqual(aliased.agents, manifest.agents, '项目内别名不能跳过真实祖先规则');
  assert.equal(aliased.target, join(project, 'apps/api/src/new.ts'));
  assert.equal((await contextManifest(options)).agents.length, 2, '默认只叠加项目根规则');
  await rm(join(codex, 'AGENTS.md'));
  assert.equal((await contextManifest(options)).agents[0].path, join(agents, 'AGENTS.md'));
  await symlink(join(dir, 'missing'), join(codex, 'AGENTS.md'));
  await assert.rejects(contextManifest(options), '存在但损坏的首选规则不能静默回退');
  await assert.rejects(contextManifest(options, { path: '../other' }));
});

test('skills 多层递归、隐藏目录、YAML 名称去重及稳定来源优先级', async (t) => {
  const { options, put, codex, agents } = await fixture(t);
  await put(join(codex, 'skills/team/frontend/react/SKILL.md'), '---\nname: "react" # comment\ndescription: >-\n  第一行\n  第二行\n---\nPRIVATE_BODY');
  await put(join(agents, 'skills/different-folder/SKILL.md'), '---\nname: react\ndescription: shadowed\n---\nSHADOWED_BODY');
  await put(join(agents, 'skills/team/backend/SKILL.md'), '---\nname: backend\n---\nbackend body');
  await put(join(codex, 'skills/.system/no-name/SKILL.md'), '# 使用目录名');
  await put(join(codex, 'skills/empty-frontmatter/SKILL.md'), '---\n---\n空元数据仍使用目录名');
  await put(join(codex, 'skills/a/SKILL.md'), '---\nname: same-source\n---\na');
  await put(join(codex, 'skills/z/SKILL.md'), '---\nname: same-source\n---\nz');
  await put(join(codex, 'skills/invalid/SKILL.md'), '---\nname: [\n---\n');
  await put(join(codex, 'skills/parent/SKILL.md'), '---\nname: parent\n---\nparent');
  await put(join(codex, 'skills/parent/child/SKILL.md'), '---\nname: child\n---\nchild');
  await put(join(codex, 'skills/utf8/SKILL.md'), `---\nname: utf8\ndescription: "${'界'.repeat(1000)}"\n---\nbody`);
  const manifest = await contextManifest({ ...options, contextReadRoots: ['~/.agents', '~/.codex'] });
  assert.deepEqual(manifest.skills.map((entry) => entry.name), ['backend', 'child', 'empty-frontmatter', 'no-name', 'parent', 'react', 'same-source', 'utf8']);
  const react = manifest.skills.find((entry) => entry.name === 'react');
  assert.equal(react.path, join(codex, 'skills/team/frontend/react/SKILL.md'));
  assert.equal(react.description, '第一行 第二行');
  assert.equal(manifest.skills.find((entry) => entry.name === 'same-source').path, join(codex, 'skills/a/SKILL.md'));
  assert.equal(manifest.skills.find((entry) => entry.name === 'utf8').description, '界'.repeat(1000));
  assert.equal(JSON.stringify(manifest).includes('PRIVATE_BODY'), false);
  assert.equal(JSON.stringify(manifest).includes('SHADOWED_BODY'), false);
  assert.equal(manifest.warnings[0].code, 'INVALID_SKILL_METADATA');
  assert.match((await readContext(options, { path: react.path })).content, /PRIVATE_BODY/);
  assert.equal((await contextManifest({ ...options, contextReadRoots: [] })).skills.length, 0);
});

test('read_context 展开 Home、支持整个授权根及分页，拒绝其他目录、异常参数和外链', async (t) => {
  const { dir, options, put, codex, agents } = await fixture(t);
  await put(join(codex, 'AGENTS.md'), 'one\ntwo\nthree');
  await put(join(codex, 'memories/nested/note.md'), 'memory');
  await put(join(agents, 'custom/data.txt'), 'custom');
  await put(join(dir, 'private/secret.txt'), 'secret');
  assert.match((await readContext(options, { path: '~/.codex/AGENTS.md', offset: 2, limit: 1 })).content, /^two\n\n\[truncated/);
  assert.equal((await readContext(options, { path: join(codex, 'memories/nested/note.md') })).content, 'memory');
  assert.equal((await readContext(options, { path: '~/.agents/custom/data.txt' })).content, 'custom');
  for (const path of ['../private/secret.txt', join(dir, 'private/secret.txt'), '~/.codex/../../private/secret.txt', '~someone/file', '\0']) {
    await assert.rejects(readContext(options, { path }));
  }
  await assert.rejects(readContext({ ...options, contextReadRoots: [] }, { path: '~/.codex/AGENTS.md' }));
  await symlink(join(dir, 'private'), join(codex, 'outside'), 'dir');
  await assert.rejects(readContext(options, { path: '~/.codex/outside/secret.txt' }), /软链接/);
  await symlink(join(agents, 'custom'), join(codex, 'shared'), 'dir');
  assert.equal((await readContext(options, { path: '~/.codex/shared/data.txt' })).content, 'custom');
  for (const args of [{ offset: 0 }, { offset: 1.1 }, { offset: 99 }, { limit: 0 }, { limit: 1001 }, { limit: NaN }]) {
    await assert.rejects(readContext(options, { path: '~/.codex/AGENTS.md', ...args }));
  }
  await assert.rejects(readContext(options, { path: '~/.codex' }), /普通文件/);
  await put(join(codex, 'large.txt'), 'a'.repeat(1024 * 1024 + 1));
  await assert.rejects(readContext(options, { path: '~/.codex/large.txt' }), /1 MiB/);
});

test('递归扫描跳过越界链接并终止链接循环，普通文件工具不能借链接写出项目', async (t) => {
  const { dir, options, put, codex } = await fixture(t);
  await put(join(codex, 'skills/real/SKILL.md'), '---\nname: linked\n---\nbody');
  await symlink(join(codex, 'skills'), join(codex, 'skills/real/loop'), 'dir');
  await put(join(dir, 'private/skill/SKILL.md'), '---\nname: outside\n---\nsecret');
  await symlink(join(dir, 'private'), join(codex, 'skills/external'), 'dir');
  const manifest = await contextManifest(options);
  assert.deepEqual(manifest.skills.map((entry) => entry.name), ['linked']);
  assert.equal(manifest.warnings[0].code, 'OUTSIDE_READ_ROOTS');
  await put(join(codex, 'AGENTS.md'), 'original');
  await symlink(codex, join(options.cwd, 'external'), 'dir');
  await assert.rejects(readTool(options, { path: 'external/AGENTS.md' }));
  await assert.rejects(writeTool(options, { path: 'external/new/sub.txt', content: 'bad' }));
  await assert.rejects(editTool(options, { path: 'external/AGENTS.md', edits: [{ oldText: 'original', newText: 'bad' }] }));
  await assert.rejects(contextManifest(options, { path: 'external/AGENTS.md' }));
  await symlink(join(codex, 'not-created'), join(options.cwd, 'dangling'));
  await assert.rejects(writeTool(options, { path: 'dangling', content: 'bad' }));
  await assert.rejects(writeTool(options, { path: '../new.txt', content: 'bad' }));
  await writeTool(options, { path: 'nested/new.txt', content: 'good' });
  await editTool(options, { path: 'nested/new.txt', edits: [{ oldText: 'good', newText: 'better' }] });
  assert.equal((await readTool(options, { path: 'nested/new.txt' })).content, 'better');
  assert.equal(await readFile(join(codex, 'AGENTS.md'), 'utf8'), 'original');
});
