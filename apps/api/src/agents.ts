import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { DatabaseHandle, WorkspaceTokenMatch } from "@m-tunnel/db";
import { hashToken } from "./auth.js";

export type ToolReply = { ok: boolean; content: string; details?: { exitCode?: number; stderr?: string } };
export type Pending = { resolve: (value: ToolReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type Agent = { socket: WebSocket; tokenId: string; workspacePath: string; platform: string; pending: Map<string, Pending> };

export function attachAgentServer(server: Server, db: DatabaseHandle, agents: Map<string, Agent>): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const secret = url.pathname.startsWith("/agent/") ? decodeURIComponent(url.pathname.slice(7)) : "";
      const match = secret ? await db.findWorkspaceToken(hashToken(secret)) : null;
      if (!match) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, match, hashToken(secret)));
    } catch { console.error(JSON.stringify({ event: "agent_upgrade_failed" })); socket.destroy(); }
  });
  wss.on("connection", (client: WebSocket, match: WorkspaceTokenMatch, tokenHash: string) => {
    const workspaceId = match.workspace.id;
    const agent: Agent = { socket: client, tokenId: match.token.id, workspacePath: "", platform: "", pending: new Map() };
    let registered = false;
    let registering = false;
    const deadline = setTimeout(() => client.close(4000, "registration_timeout"), 15_000);
    client.on("message", async (raw: Buffer) => {
      try {
        const message: unknown = JSON.parse(raw.toString());
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "agent_hello" && !registered && !registering) {
          registering = true;
          const hello = message as Record<string, unknown>;
          const path = hello.workspace;
          const platform = hello.platform;
          const name = hello.name ?? (typeof path === "string" ? path.split(/[\\/]/).filter(Boolean).at(-1) : undefined);
          const bindingKey = hello.bindingKey ?? `${platform}:${path}`;
          if (typeof path !== "string" || !path || path.length > 4096 || typeof platform !== "string" || platform.length > 50 || typeof name !== "string" || !name.trim() || name.length > 255 || typeof bindingKey !== "string" || !bindingKey || bindingKey.length > 4096) {
            client.close(4000, "invalid_workspace"); return;
          }
          // Recheck revocation after upgrade, before binding the credential.
          if (!(await db.findWorkspaceToken(tokenHash))) { client.close(4001, "token_revoked"); return; }
          const bound = await db.registerWorkspaceAgent(workspaceId, bindingKey, name.trim(), path, platform);
          if (!bound) { client.close(4003, "workspace_mismatch"); return; }
          if (!(await db.findWorkspaceToken(tokenHash))) { client.close(4001, "token_revoked"); return; }
          if (client.readyState !== WebSocket.OPEN) return;
          const previous = agents.get(workspaceId);
          // A superseded window must stop reconnecting, otherwise two windows
          // continually evict each other and tool calls reach the wrong folder.
          previous?.socket.close(4009, "replaced");
          agent.workspacePath = path; agent.platform = platform;
          agents.set(workspaceId, agent); registered = true; clearTimeout(deadline);
          client.send(JSON.stringify({ type: "agent_ready", workspaceId, name: name.trim() }));
          console.log(JSON.stringify({ event: "agent_registered", workspaceId, tokenId: agent.tokenId }));
        }
        if (message.type === "tool_result" && registered && agents.get(workspaceId) === agent) {
          const reply = message as Record<string, unknown>;
          if (typeof reply.id !== "string" || typeof reply.content !== "string") return;
          const item = agent.pending.get(reply.id);
          if (!item) return;
          clearTimeout(item.timer); agent.pending.delete(reply.id);
          item.resolve({ ok: reply.ok === true, content: reply.content });
        }
      } catch {
        console.error(JSON.stringify({ event: "agent_message_failed", workspaceId, registered }));
        if (!registered) client.close(4000, "registration_failed");
      }
    });
    client.on("error", () => console.error(JSON.stringify({ event: "agent_socket_error", workspaceId })));
    client.on("close", () => {
      clearTimeout(deadline);
      if (agents.get(workspaceId) === agent) agents.delete(workspaceId);
      for (const [id, item] of agent.pending) { clearTimeout(item.timer); item.reject(new Error("VS Code agent disconnected")); agent.pending.delete(id); }
      console.log(JSON.stringify({ event: "agent_disconnected", workspaceId }));
    });
  });
}
