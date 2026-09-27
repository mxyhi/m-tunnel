import * as vscode from "vscode";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import type { AgentMessage, ToolCallMessage, ToolName } from "@m-tunnel/protocol";

type JsonObject = Record<string, unknown>;
type ToolReply = { ok: boolean; content: string; details?: { exitCode?: number; stderr?: string } };

let socket: WebSocket | undefined;
let statusBar: vscode.StatusBarItem;
let heartbeatTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectEnabled = true;

function rootFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("Open a workspace before connecting m-tunnel");
  return folder;
}

function workspacePath(root: vscode.WorkspaceFolder, requested: string): vscode.Uri {
  const rootPath = resolve(root.uri.fsPath);
  const target = resolve(rootPath, requested);
  const rel = relative(rootPath, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(rel) === resolve("..")) throw new Error(`Path is outside the workspace: ${requested}`);
  return vscode.Uri.file(target);
}

async function readTool(root: vscode.WorkspaceFolder, args: JsonObject): Promise<ToolReply> {
  const path = workspacePath(root, stringArg(args, "path"));
  const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(path));
  const lines = content.split("\n");
  const start = Math.max(0, numberArg(args, "offset", 1) - 1);
  const limit = numberArg(args, "limit", 400);
  if (start >= lines.length) throw new Error(`Offset ${start + 1} exceeds ${lines.length} lines`);
  const end = Math.min(lines.length, start + limit);
  return { ok: true, content: lines.slice(start, end).join("\n") + (end < lines.length ? `\n\n[truncated; continue with offset=${end + 1}]` : "") };
}

async function writeTool(root: vscode.WorkspaceFolder, args: JsonObject): Promise<ToolReply> {
  const relativePath = stringArg(args, "path"); const uri = workspacePath(root, relativePath);
  const parent = vscode.Uri.file(dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(parent);
  const content = stringArg(args, "content");
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  return { ok: true, content: `Wrote ${relativePath} (${new TextEncoder().encode(content).byteLength} bytes).` };
}

async function editTool(root: vscode.WorkspaceFolder, args: JsonObject): Promise<ToolReply> {
  const relativePath = stringArg(args, "path"); const uri = workspacePath(root, relativePath);
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

async function execute(root: vscode.WorkspaceFolder, tool: ToolName, args: JsonObject): Promise<ToolReply> {
  if (tool === "read") return readTool(root, args); if (tool === "write") return writeTool(root, args); if (tool === "edit") return editTool(root, args); return bashTool(root, args);
}

function stringArg(args: JsonObject, key: string): string { const value = args[key]; if (typeof value !== "string") throw new Error(`${key} must be a string`); return value; }
function numberArg(args: JsonObject, key: string, fallback: number): number { const value = args[key]; return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

function connect(context: vscode.ExtensionContext): void {
  reconnectEnabled = true;
  const config = vscode.workspace.getConfiguration("mTunnel"); const relay = config.get<string>("relayUrl", "https://mtunnel.mxyhi.com").replace(/\/$/, ""); const secret = config.get<string>("token", "");
  if (!secret) { statusBar.text = "$(warning) m-tunnel token missing"; statusBar.tooltip = "Set mTunnel.token in VS Code settings"; return; }
  const root = rootFolder(); const url = `${relay.replace(/^http/, "ws")}/agent/${encodeURIComponent(secret)}`;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
  socket?.close(); socket = new WebSocket(url);
  socket.on("open", () => {
    statusBar.text = "$(plug) m-tunnel connected";
    socket?.send(JSON.stringify({ type: "agent_hello", workspace: root.uri.fsPath, platform: process.platform }));
    heartbeatTimer = setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.ping(); }, 30_000);
  });
  socket.on("message", async (raw: Buffer) => {
    try {
      const message = JSON.parse(raw.toString()) as Partial<ToolCallMessage>;
      if (message.type !== "tool_call" || typeof message.id !== "string" || !message.tool || !message.arguments || (message.tool !== "read" && message.tool !== "bash" && message.tool !== "edit" && message.tool !== "write")) return;
      let result: ToolReply; try { result = await execute(root, message.tool, message.arguments as unknown as JsonObject); } catch (error) { result = { ok: false, content: error instanceof Error ? error.message : String(error) }; }
      socket?.send(JSON.stringify({ type: "tool_result", id: message.id, ...result } satisfies AgentMessage & ToolReply));
    } catch { /* ignore malformed relay messages */ }
  });
  socket.on("close", () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    statusBar.text = "$(circle-slash) m-tunnel disconnected";
    if (reconnectEnabled && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(context); }, 5_000);
  });
  socket.on("error", () => { statusBar.text = "$(error) m-tunnel error"; });
  context.subscriptions.push({ dispose: () => socket?.close() });
}

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100); statusBar.text = "$(plug) m-tunnel"; statusBar.show(); context.subscriptions.push(statusBar);
  context.subscriptions.push(vscode.commands.registerCommand("m-tunnel.start", () => connect(context)));
  context.subscriptions.push(vscode.commands.registerCommand("m-tunnel.stop", () => { reconnectEnabled = false; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; } if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; } socket?.close(); socket = undefined; statusBar.text = "$(circle-slash) m-tunnel stopped"; }));
  context.subscriptions.push(vscode.commands.registerCommand("m-tunnel.copyMcpUrl", async () => { const config = vscode.workspace.getConfiguration("mTunnel"); const url = `${config.get<string>("relayUrl", "https://mtunnel.mxyhi.com")}/mcp/${encodeURIComponent(config.get<string>("token", ""))}`; await vscode.env.clipboard.writeText(url); void vscode.window.showInformationMessage("m-tunnel MCP URL copied"); }));
  if (vscode.workspace.getConfiguration("mTunnel").get<boolean>("autoStart", true)) connect(context);
}

export function deactivate(): void { reconnectEnabled = false; if (reconnectTimer) clearTimeout(reconnectTimer); if (heartbeatTimer) clearInterval(heartbeatTimer); socket?.close(); }
