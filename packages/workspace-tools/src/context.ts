import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { load, JSON_SCHEMA } from "js-yaml";
import { allowedPath, expandPath, isMissing, isWithin, PathAccessError, readRoots, resolveWorkspacePath } from "./paths.js";
import type { ReadRoot } from "./paths.js";

export const defaultContextReadRoots = ["~/.codex", "~/.agents"] as const;
export interface ContextOptions { cwd: string; home?: string; contextReadRoots?: readonly string[] }
export interface AgentInstruction { path: string; scope: "global" | "project"; directory: string }
export interface SkillEntry { name: string; description: string; path: string; source: string }
export interface ContextManifest {
  target: string;
  agents: AgentInstruction[];
  skills: SkillEntry[];
  warnings: Array<{ path: string; code: string }>;
}

async function contextRoots(options: ContextOptions): Promise<ReadRoot[]> {
  const paths = (options.contextReadRoots ?? defaultContextReadRoots).map((path) => expandPath(options.cwd, path, options.home));
  return readRoots([resolve(options.cwd), ...paths]);
}

// 索引只解析有大小限制的 YAML 头；正文留给 read_context 按需读取。
async function skillMetadata(path: string): Promise<{ name?: string; description?: string }> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024);
    const decoder = new StringDecoder("utf8");
    let header = "";
    for (let size = 0; size < 65536; size += buffer.length) {
      const { bytesRead } = await file.read(buffer);
      header += decoder.write(buffer.subarray(0, bytesRead));
      if (bytesRead === 0) header += decoder.end() + "\n";
      if (!/^\uFEFF?---\r?\n/.test(header)) return {};
      const match = /^\uFEFF?---\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*\r?\n/m.exec(header);
      if (match) {
        const value: unknown = load(match[1] ?? "", { schema: JSON_SCHEMA });
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        const record = value as Record<string, unknown>;
        if (typeof record.name === "string" && record.name.trim().length > 128) throw new Error("SKILL_NAME_TOO_LONG");
        return {
          ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
          ...(typeof record.description === "string" ? { description: record.description.trim().slice(0, 2048) } : {})
        };
      }
      if (bytesRead === 0) throw new Error("SKILL_FRONTMATTER_UNCLOSED");
    }
    throw new Error("SKILL_FRONTMATTER_TOO_LARGE");
  } finally { await file.close(); }
}

export async function contextManifest(options: ContextOptions, input: { path?: string } = {}): Promise<ContextManifest> {
  const root = resolve(options.cwd);
  const home = options.home ?? homedir();
  const roots = await contextRoots(options);
  const projectRoots = await readRoots([root]);
  const requested = resolveWorkspacePath(root, input.path ?? ".");
  // 目标必须留在项目内，即使外部目录有只读授权，也不能改变项目规则的作用域。
  const realTarget = await allowedPath(requested, projectRoots, true);
  const project = projectRoots[0];
  if (!project) throw new Error("工作区目录不存在");
  // 文件工具操作真实目标；规则链也须沿真实目标收集，不能被目录别名省略。
  const target = resolve(root, relative(project.realPath, realTarget));
  let directory = dirname(target);
  try { if ((await stat(target)).isDirectory()) directory = target; }
  catch (error) { if (!isMissing(error)) throw error; }
  const result: ContextManifest = { target, agents: [], skills: [], warnings: [] };

  for (const base of [join(home, ".codex"), join(home, ".agents")]) {
    const path = join(base, "AGENTS.md");
    if (!roots.some((item) => isWithin(item.path, path))) continue;
    try { await lstat(path); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    const resolved = await allowedPath(path, roots);
    if (!(await stat(resolved)).isFile()) throw new Error("AGENTS.md 必须是文件");
    result.agents.push({ path, scope: "global", directory: base });
    break; // 首选存在时不合并另一份全局规则；异常也不能静默回退。
  }

  const directories: string[] = [];
  for (let current = directory; isWithin(root, current); current = dirname(current)) {
    directories.unshift(current);
    if (current === root) break;
  }
  for (const current of directories) {
    const path = join(current, "AGENTS.md");
    try { await lstat(path); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    const resolved = await allowedPath(path, projectRoots);
    if (!(await stat(resolved)).isFile()) throw new Error("AGENTS.md 必须是文件");
    result.agents.push({ path, scope: "project", directory: current });
  }

  const skills = new Map<string, SkillEntry>();
  let entriesScanned = 0;
  // 固定来源优先级，不受配置数组顺序影响。同源按路径排序，结果可重复。
  for (const source of [join(home, ".codex"), join(home, ".agents")]) {
    const start = join(source, "skills");
    if (!roots.some((item) => isWithin(item.path, start))) continue;
    const visited = new Set<string>();
    const walk = async (path: string): Promise<void> => {
      if (++entriesScanned > 10000) throw new Error("skills 扫描超过 10000 项，请缩小目录范围");
      let real: string;
      try { real = await allowedPath(path, roots); }
      catch (error) {
        if (isMissing(error)) return;
        if (error instanceof PathAccessError) { result.warnings.push({ path, code: "OUTSIDE_READ_ROOTS" }); return; }
        throw error;
      }
      const info = await stat(real);
      if (info.isDirectory()) {
        if (visited.has(real)) return;
        visited.add(real); // 跟随授权范围内的目录链接，但不重复访问或陷入循环。
        for (const entry of (await readdir(real)).sort()) {
          if (entry !== ".git" && entry !== "node_modules") await walk(join(path, entry));
        }
      } else if (info.isFile() && basename(path) === "SKILL.md") {
        try {
          const metadata = await skillMetadata(real);
          const name = metadata.name ?? basename(dirname(path));
          if (!skills.has(name)) skills.set(name, { name, description: metadata.description ?? "", path, source });
        } catch {
          // YAML 错误可能携带原文，只返回路径与固定错误码。
          result.warnings.push({ path, code: "INVALID_SKILL_METADATA" });
        }
      }
    };
    await walk(start);
  }
  result.skills = [...skills.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return result;
}

export async function readContext(options: ContextOptions, input: { path: string; offset?: number; limit?: number }): Promise<{ content: string }> {
  const path = await allowedPath(expandPath(options.cwd, input.path, options.home), await contextRoots(options));
  const info = await stat(path);
  if (!info.isFile()) throw new Error("read_context 仅支持普通文件");
  if (info.size > 1024 * 1024) throw new Error("上下文文件不能超过 1 MiB");
  const offset = input.offset ?? 1; const limit = input.limit ?? 400;
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("offset 必须是正整数，limit 必须为 1–1000");
  const lines = (await readFile(path, "utf8")).split("\n");
  if (offset > lines.length) throw new Error("offset 超过文件行数");
  const end = Math.min(lines.length, offset - 1 + limit);
  return { content: lines.slice(offset - 1, end).join("\n") + (end < lines.length ? `\n\n[truncated; continue with offset=${end + 1}]` : "") };
}
