import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface ReadRoot { path: string; realPath: string }
export class PathAccessError extends Error {}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function expandPath(cwd: string, requested: string, home = homedir()): string {
  if (!requested || requested.includes("\0")) throw new Error("路径不能为空或包含 NUL");
  if (requested === "~") return resolve(home);
  if (/^~[/\\]/.test(requested)) return resolve(home, requested.slice(2));
  if (requested.startsWith("~")) throw new Error("仅支持 ~ 或 ~/ 开头的 Home 路径");
  return resolve(cwd, requested);
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readRoots(paths: readonly string[]): Promise<ReadRoot[]> {
  const roots: ReadRoot[] = [];
  for (const path of paths) {
    try { roots.push({ path: resolve(path), realPath: await realpath(path) }); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  return roots;
}

// 对新文件检查最近的已有祖先；悬空软链接不能作为可创建的新路径。
async function prospectiveRealPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!isMissing(error)) throw error;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new PathAccessError("拒绝悬空软链接");
    } catch (statError) { if (!isMissing(statError)) throw statError; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await prospectiveRealPath(parent), relative(parent, path));
  }
}

export async function allowedPath(path: string, roots: readonly ReadRoot[], allowMissing = false): Promise<string> {
  if (!roots.some((root) => isWithin(root.path, path))) throw new PathAccessError("路径不在允许的目录内");
  const target = allowMissing ? await prospectiveRealPath(path) : await realpath(path);
  if (!roots.some((root) => isWithin(root.realPath, target))) throw new PathAccessError("软链接目标不在允许的目录内");
  return target;
}

export function resolveWorkspacePath(cwd: string, requested: string): string {
  const path = resolve(cwd, requested);
  if (!isWithin(resolve(cwd), path)) throw new PathAccessError(`Path is outside the workspace: ${requested}`);
  return path;
}

export async function workspaceFilePath(cwd: string, requested: string, allowMissing = false): Promise<string> {
  return allowedPath(resolveWorkspacePath(cwd, requested), await readRoots([cwd]), allowMissing);
}
