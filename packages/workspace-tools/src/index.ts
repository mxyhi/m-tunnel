import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface ToolContext { readonly cwd: string }
export interface ToolResult { readonly content: string; readonly details?: { exitCode?: number; stderr?: string } }

export function resolveWorkspacePath(cwd: string, requested: string): string {
  const root = resolve(cwd);
  const candidate = resolve(root, requested);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${requested}`);
  return candidate;
}

export async function readTool(ctx: ToolContext, input: { path: string; offset?: number; limit?: number }): Promise<ToolResult> {
  const path = resolveWorkspacePath(ctx.cwd, input.path);
  await access(path, constants.R_OK);
  const lines = (await readFile(path, "utf8")).split("\n");
  const start = Math.max(0, (input.offset ?? 1) - 1);
  const limit = input.limit ?? 400;
  if (start >= lines.length) throw new Error(`Offset ${input.offset ?? 1} exceeds ${lines.length} lines`);
  const end = Math.min(lines.length, start + limit);
  return { content: lines.slice(start, end).join("\n") + (end < lines.length ? `\n\n[truncated; continue with offset=${end + 1}]` : "") };
}

export async function writeTool(ctx: ToolContext, input: { path: string; content: string }): Promise<ToolResult> {
  const path = resolveWorkspacePath(ctx.cwd, input.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.content, "utf8");
  return { content: `Wrote ${input.path} (${Buffer.byteLength(input.content, "utf8")} bytes).` };
}

export async function editTool(ctx: ToolContext, input: { path: string; edits: Array<{ oldText: string; newText: string }> }): Promise<ToolResult> {
  const path = resolveWorkspacePath(ctx.cwd, input.path);
  await access(path, constants.R_OK | constants.W_OK);
  const original = await readFile(path, "utf8");
  let next = original;
  for (const edit of input.edits) {
    const count = next.split(edit.oldText).length - 1;
    if (count !== 1) throw new Error(`oldText must match exactly once in ${input.path}; found ${count}`);
    next = next.replace(edit.oldText, edit.newText);
  }
  await writeFile(path, next, "utf8");
  return { content: `Edited ${input.path} (${input.edits.length} replacement(s)).` };
}

export async function bashTool(ctx: ToolContext, input: { command: string; timeout?: number }): Promise<ToolResult> {
  const timeout = Math.min(Math.max(input.timeout ?? 120_000, 1_000), 300_000);
  return await new Promise<ToolResult>((resolvePromise, reject) => {
    const child = spawn(input.command, { cwd: ctx.cwd, shell: true, env: process.env });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Command timed out after ${timeout}ms`)); }, timeout);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ content: stdout || stderr || `Command exited with ${code ?? 1}.`, details: { exitCode: code ?? 1, stderr } }); });
  });
}


export async function runSelfTest(): Promise<void> {
  const root = resolve((await import("node:os")).tmpdir(), "m-tunnel-tools-test");
  await writeTool({ cwd: root }, { path: "test.txt", content: "a\nb\n" });
  if (!(await readTool({ cwd: root }, { path: "test.txt" })).content.includes("a")) throw new Error("read self-test failed");
  await editTool({ cwd: root }, { path: "test.txt", edits: [{ oldText: "b", newText: "c" }] });
  if ((await readFile(resolve(root, "test.txt"), "utf8")) !== "a\nc\n") throw new Error("edit self-test failed");
}
