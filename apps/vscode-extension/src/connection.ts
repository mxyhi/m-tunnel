import * as vscode from "vscode";
import WebSocket from "ws";
import { agentToolNames, isToolName, type ToolCallMessage, type ToolName } from "@m-tunnel/protocol";
import { mcpUrl, parseConnectionUri, validateConnection, type ConnectionConfig } from "./connection-config.js";

type ToolReply = { ok: boolean; content: string; details?: { exitCode?: number; stderr?: string } };
type Execute = (root: vscode.WorkspaceFolder, tool: ToolName, args: Record<string, unknown>) => Promise<ToolReply>;

export function activateConnections(context: vscode.ExtensionContext, execute: Execute): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const output = vscode.window.createOutputChannel("m-tunnel");
  status.text = "$(plug) m-tunnel"; status.command = "m-tunnel.menu"; status.show();
  let client: WebSocket | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let reconnect: NodeJS.Timeout | undefined;
  let generation = 0;
  let enabled = true;
  let activeConfig: ConnectionConfig | undefined;
  let notifyOnReady = false;
  let failureNotified = false;

  const rootFolder = (): vscode.WorkspaceFolder => {
    if (!vscode.workspace.isTrusted) throw new Error("请先信任当前工作区，再连接 m-tunnel");
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) throw new Error("请先在 VS Code 中打开目标文件夹，然后重新导入连接");
    return root;
  };
  const secretKey = (root: vscode.WorkspaceFolder) => `connection:${root.uri.toString()}`;
  const loadConfig = async (root: vscode.WorkspaceFolder): Promise<ConnectionConfig | undefined> => {
    const saved = await context.secrets.get(secretKey(root));
    if (saved) {
      const value = JSON.parse(saved) as ConnectionConfig;
      return validateConnection(value.relayUrl, value.token);
    }
    // Existing settings remain readable during migration. New imports are stored
    // per folder in SecretStorage, never in a repository's settings.json.
    const settings = vscode.workspace.getConfiguration("mTunnel", root.uri);
    const token = settings.get<string>("token", "");
    return token ? validateConnection(settings.get<string>("relayUrl", "https://mtunnel.mxyhi.com"), token) : undefined;
  };
  const stop = () => {
    generation++;
    if (reconnect) clearTimeout(reconnect); reconnect = undefined;
    if (heartbeat) clearInterval(heartbeat); heartbeat = undefined;
    const previous = client; client = undefined; previous?.close();
  };
  const reportFailure = (message: string) => {
    status.tooltip = message;
    if (!failureNotified) { failureNotified = true; void vscode.window.showErrorMessage(`m-tunnel：${message}`); }
  };
  const copyUrl = async () => {
    try {
      const config = activeConfig ?? await loadConfig(rootFolder());
      if (!config) throw new Error("尚未配置连接，请先从管理台导入");
      await vscode.env.clipboard.writeText(mcpUrl(config));
      void vscode.window.showInformationMessage("m-tunnel：MCP 链接已复制");
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : "复制失败"); }
  };
  const connect = async (interactive = false): Promise<void> => {
    stop(); enabled = true;
    if (interactive) { notifyOnReady = true; failureNotified = false; }
    const attempt = generation;
    try {
      const root = rootFolder();
      const config = await loadConfig(root);
      if (attempt !== generation) return;
      if (!config) {
        status.text = "$(plug) m-tunnel 待配置"; status.tooltip = "点击打开管理台并导入连接";
        if (interactive) void vscode.window.showInformationMessage("请在管理台点击“连接 VS Code”，然后导入连接。", "打开管理台").then((choice) => { if (choice) void vscode.env.openExternal(vscode.Uri.parse("https://mtunnel.mxyhi.com")); });
        return;
      }
      activeConfig = config;
      status.text = "$(sync~spin) m-tunnel 连接中";
      const ws = new WebSocket(`${config.relayUrl.replace(/^http/, "ws")}/agent/${encodeURIComponent(config.token)}`);
      client = ws;
      let ready = false;
      let terminal = false;
      const deadline = setTimeout(() => { if (client === ws && !ready) { reportFailure("工作区登记超时，请确认服务端已更新"); ws.close(); } }, 20_000);
      ws.on("open", () => {
        if (client !== ws) return;
        ws.send(JSON.stringify({ type: "agent_hello", name: root.name, workspace: root.uri.fsPath, platform: process.platform, bindingKey: `${vscode.env.machineId}:${root.uri.toString()}`, tools: agentToolNames }));
      });
      ws.on("message", async (raw: Buffer) => {
        if (client !== ws) return;
        try {
          const message = JSON.parse(raw.toString()) as Partial<ToolCallMessage> & { name?: unknown };
          if ((message as { type?: string }).type === "agent_ready") {
            if (ready) return;
            ready = true; clearTimeout(deadline);
            status.text = "$(plug) m-tunnel 已连接"; status.tooltip = `${root.name} · ${new URL(config.relayUrl).host}\n点击复制 MCP 链接或管理连接`;
            heartbeat = setInterval(() => { if (client === ws && ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
            output.appendLine(JSON.stringify({ event: "agent_ready", workspace: root.name }));
            if (notifyOnReady) {
              notifyOnReady = false;
              void vscode.window.showInformationMessage(`m-tunnel：配置成功，已连接“${root.name}”`, "复制 MCP 链接").then((choice) => { if (choice) void copyUrl(); });
            }
            failureNotified = false;
            return;
          }
          if (!ready || message.type !== "tool_call" || typeof message.id !== "string") return;
          let result: ToolReply;
          try {
            if (!isToolName(message.tool)) throw new Error("不支持的工具，请更新 m-tunnel 插件");
            if (!message.arguments || typeof message.arguments !== "object" || Array.isArray(message.arguments)) throw new Error("工具参数必须是对象");
            result = await execute(root, message.tool, message.arguments as unknown as Record<string, unknown>);
          }
          catch (error) { result = { ok: false, content: error instanceof Error ? error.message : String(error) }; }
          // A completed command belongs to its original connection, never to
          // whichever window/credential connected while it was running.
          if (client === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "tool_result", id: message.id, ...result }));
        } catch { output.appendLine(JSON.stringify({ event: "relay_message_invalid" })); }
      });
      ws.on("unexpected-response", (_request, response) => {
        if (client !== ws) return;
        terminal = response.statusCode === 401 || response.statusCode === 403;
        reportFailure(terminal ? "Token 无效或已撤销，请从管理台重新导入" : `服务端拒绝连接（HTTP ${response.statusCode ?? "未知"}）`);
        response.resume(); ws.terminate();
      });
      ws.on("error", () => { if (client === ws) reportFailure("连接失败，请检查服务地址和网络"); });
      ws.on("close", (code) => {
        clearTimeout(deadline);
        if (client !== ws) return;
        if (heartbeat) clearInterval(heartbeat); heartbeat = undefined;
        status.text = "$(circle-slash) m-tunnel 已断开";
        if ([4000, 4001, 4003, 4009].includes(code)) {
          terminal = true;
          reportFailure(code === 4009 ? "连接已由另一个 VS Code 窗口接管" : code === 4003 ? "此连接属于另一个文件夹，请在管理台生成新的连接" : code === 4001 ? "Token 已撤销，请重新导入连接" : "工作区登记失败，请检查服务端状态");
        }
        output.appendLine(JSON.stringify({ event: "agent_closed", code, retry: enabled && !terminal }));
        if (enabled && !terminal) reconnect = setTimeout(() => { reconnect = undefined; void connect(); }, 5000);
      });
    } catch (error) {
      status.text = "$(warning) m-tunnel 待配置";
      if (interactive) reportFailure(error instanceof Error ? error.message : "配置失败");
    }
  };

  const importConnection = async (uri: vscode.Uri) => {
    try {
      const config = parseConnectionUri(uri.toString(true));
      const root = rootFolder();
      const choice = await vscode.window.showInformationMessage(`将“${root.name}”连接到 ${config.relayUrl}？连接后该服务可执行文件和命令工具，并按本机 contextReadRoots 设置读取外部上下文（默认 ~/.codex、~/.agents）。命令以当前用户权限运行。`, { modal: true }, "连接");
      if (choice !== "连接") return;
      await context.secrets.store(secretKey(root), JSON.stringify(config));
      output.appendLine(JSON.stringify({ event: "connection_imported", workspace: root.name, relay: config.relayUrl }));
      await connect(true);
    } catch (error) { void vscode.window.showErrorMessage(`m-tunnel：${error instanceof Error ? error.message : "导入失败"}`); }
  };
  context.subscriptions.push(status, output,
    { dispose: () => { enabled = false; stop(); } },
    vscode.window.registerUriHandler({ handleUri: importConnection }),
    vscode.commands.registerCommand("m-tunnel.start", () => connect(true)),
    vscode.commands.registerCommand("m-tunnel.stop", () => { enabled = false; stop(); status.text = "$(circle-slash) m-tunnel 已停止"; }),
    vscode.commands.registerCommand("m-tunnel.copyMcpUrl", copyUrl),
    vscode.commands.registerCommand("m-tunnel.importConnection", async () => { const value = await vscode.window.showInputBox({ title: "导入 m-tunnel 连接", prompt: "粘贴管理台复制的 VS Code 导入链接", password: true, ignoreFocusOut: true }); if (value) await importConnection(vscode.Uri.parse(value)); }),
    vscode.commands.registerCommand("m-tunnel.menu", async () => {
      const choice = await vscode.window.showQuickPick(["复制 MCP 链接", "导入连接", "连接工作区", "断开连接", "打开管理台"], { title: "m-tunnel" });
      if (choice === "打开管理台") { void vscode.env.openExternal(vscode.Uri.parse(activeConfig?.relayUrl ?? "https://mtunnel.mxyhi.com")); return; }
      const command = { "复制 MCP 链接": "m-tunnel.copyMcpUrl", "导入连接": "m-tunnel.importConnection", "连接工作区": "m-tunnel.start", "断开连接": "m-tunnel.stop" };
      if (choice && choice in command) await vscode.commands.executeCommand(command[choice as keyof typeof command]);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration("mTunnel.token") || event.affectsConfiguration("mTunnel.relayUrl")) void connect(true); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { activeConfig = undefined; if (enabled) void connect(); }),
  );
  if (vscode.workspace.getConfiguration("mTunnel").get<boolean>("autoStart", true)) void connect();
}
