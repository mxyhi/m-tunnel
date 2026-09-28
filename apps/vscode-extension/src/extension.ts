import * as vscode from "vscode";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { activateConnections } from "./connection.js";
import type { ToolName } from "@m-tunnel/protocol";
import { contextManifest, readContext, defaultContextReadRoots, workspaceFilePath } from "@m-tunnel/workspace-tools";

type JsonObject = Record<string, unknown>;
type ToolReply = { ok: boolean; content: string; details?: { exitCode?: number; stderr?: string } };

async function workspacePath(root: vscode.WorkspaceFolder, requested: string, allowMissing = false): Promise<vscode.Uri> {
  return vscode.Uri.file(await workspaceFilePath(root.uri.fsPath, requested, allowMissing));
}

async function readTool(root: vscode.WorkspaceFolder, args: JsonObject): Promise<ToolReply> {
  const path = await workspacePath(root, stringArg(args, "path"));
  const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(path));
  const lines = content.split("\n");
  const start = Math.max(0, numberArg(args, "offset", 1) - 1);
  const limit = numberArg(args, "limit", 400);
  if (start >= lines.length) throw new Error(`Offset ${start + 1} exceeds ${lines.length} lines`);
  const end = Math.min(lines.length, start + limit);
  return { ok: true, content: lines.slice(start, end).join("\n") + (end < lines.length ? `\n\n[truncated; continue with offset=${end + 1}]` : "") };
}

async function writeTool(root: vscode.WorkspaceFolder, args: JsonObject): Promise<ToolReply> {
  const relativePath = stringArg(args, "path"); const uri = await workspacePath(root, relativePath, true);
  const parent = vscode.Uri.file(dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(parent);
  await workspacePath(root, relativePath, true);
  const content = stringArg(args, "content");
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  return { ok: true, content: `Wrote ${relativePath} (${new TextEncoder().encode(content).byteLength} bytes).` };
}

async function editTool(root: vscode.WorkspaceFolder, args: JsonObject): Promise<ToolReply> {
  const relativePath = stringArg(args, "path"); const uri = await workspacePath(root, relativePath);
  const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("edits must be a non-empty array");
  let next = original;
  for (const raw of edits) {
    if (!raw || typeof raw !== "object") throw new Error("Invalid edit entry");
    const edit = raw as JsonObject; const oldText = stringArg(edit, "oldText"); const newText = stringArg(edit, "newText");
    const count = next.split(oldText).length - 1;
    if (count !== 1) throw new Error(`oldText must match exactly once in ${relativePath}; found ${count}`);
    next = next.replace(oldText, newText);
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
  return { ok: true, content: `Edited ${relativePath} (${edits.length} replacement(s)).` };
}

async function bashTool(root: vscode.WorkspaceFolder, args: JsonObject): Promise<ToolReply> {
  const command = stringArg(args, "command"); const configured = vscode.workspace.getConfiguration("mTunnel").get<number>("bashTimeoutMs", 120000);
  const timeout = Math.min(Math.max(numberArg(args, "timeout", configured), 1000), 300000);
  return await new Promise<ToolReply>((resolvePromise, reject) => {
    const child = spawn(command, { cwd: root.uri.fsPath, shell: true, env: process.env });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Command timed out after ${timeout}ms`)); }, timeout);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0, content: stdout || stderr || `Command exited with ${code ?? 1}.`, details: { exitCode: code ?? 1, stderr } }); });
  });
}

export async function execute(root: vscode.WorkspaceFolder, tool: ToolName, args: JsonObject): Promise<ToolReply> {
  if (!vscode.workspace.isTrusted) throw new Error("请先信任当前工作区");
  if (tool === "read") return readTool(root, args); if (tool === "write") return writeTool(root, args); if (tool === "edit") return editTool(root, args); if (tool === "bash") return bashTool(root, args);
  // 只采用用户/远端机器配置，仓库 settings.json 不得扩大本机读取权限。
  const setting = vscode.workspace.getConfiguration("mTunnel").inspect<string[]>("contextReadRoots");
  const roots: unknown = setting?.globalValue ?? setting?.defaultValue ?? defaultContextReadRoots;
  if (!Array.isArray(roots) || !roots.every((path): path is string => typeof path === "string" && path.length > 0)) throw new Error("contextReadRoots 必须是路径字符串数组");
  const options = { cwd: root.uri.fsPath, contextReadRoots: roots };
  if (tool === "context_manifest") {
    const manifest = await contextManifest(options, args.path === undefined ? {} : { path: stringArg(args, "path") });
    console.info(JSON.stringify({ event: "context_manifest", agentCount: manifest.agents.length, skillCount: manifest.skills.length, warningCount: manifest.warnings.length }));
    return { ok: true, content: JSON.stringify(manifest) };
  }
  if (tool === "read_context") return { ok: true, ...await readContext(options, { path: stringArg(args, "path"), offset: contextNumberArg(args, "offset", 1), limit: contextNumberArg(args, "limit", 400) }) };
  throw new Error(`不支持的工具：${tool}`);
}

function contextNumberArg(args: JsonObject, key: string, fallback: number): number { const value = args[key]; if (value === undefined) return fallback; if (typeof value !== "number") throw new Error(`${key} 必须是数字`); return value; }

function stringArg(args: JsonObject, key: string): string { const value = args[key]; if (typeof value !== "string") throw new Error(`${key} must be a string`); return value; }
function numberArg(args: JsonObject, key: string, fallback: number): number { const value = args[key]; return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

export function activate(context: vscode.ExtensionContext): void {
  activateConnections(context, execute);
}
