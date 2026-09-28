import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { WebSocket } from "ws";
import { attachAgentServer, type Agent, type ToolReply } from "./agents.js";
import { createDatabase, type DatabaseHandle, type GlobalRole, type SessionRecord, type WorkspaceRole } from "@m-tunnel/db";
import type { Server } from "node:http";
import { clearSessionCookie, cookieValue, createToken, hashPassword, hashToken, sessionCookie, verifyPassword } from "./auth.js";
import { agentToolNames } from "@m-tunnel/protocol";

const port = Number(process.env.PORT ?? 18290);
const db = await createDatabase();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const toolNames = [...agentToolNames, "workspace_info"] as const;
type RelayTool = (typeof toolNames)[number];
type JsonObject = Record<string, unknown>;
type AuthUser = { id: string; email: string; role: GlobalRole };

const tools = [
  { name: "read", description: "Read a file in the VS Code workspace.", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } },
  { name: "bash", description: "Run a shell command in the VS Code workspace.", inputSchema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", minimum: 1, maximum: 300, description: "Maximum execution time in seconds. For 2 minutes use 120, not 120000. Omit to use the VS Code setting (120 seconds by default)." } }, required: ["command"] } },
  { name: "edit", description: "Edit a file using exact unique oldText/newText replacements.", inputSchema: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } }, required: ["oldText", "newText"] } } }, required: ["path", "edits"] } },
  { name: "write", description: "Write or create a file in the VS Code workspace.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "context_manifest", description: "开始任务及切换目标目录时先调用。返回所选全局 AGENTS.md、项目根到目标目录的逐层 AGENTS.md，以及递归发现并按名称去重的 skills 元数据。全局和同名 skills 优先 ~/.codex，回退 ~/.agents；项目规则叠加，深层规则在其子树内覆盖冲突。随后使用 read_context 按顺序读取规则，按需读取 skill 正文及其引用。", inputSchema: { type: "object", properties: { path: { type: "string", description: "工作区内的目标文件（可尚未创建）或已有目录，默认项目根目录。" } }, additionalProperties: false } },
  { name: "read_context", description: "按需读取 context_manifest 中的规则、skill 或其引用的上下文文件，支持相对路径、绝对路径和 ~/。仅允许工作区和本机 contextReadRoots（默认 ~/.codex、~/.agents）内的普通文件，最多 1 MiB；正文不存入调用记录。", inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["path"], additionalProperties: false } },
  { name: "workspace_info", description: "Get the connected VS Code workspace path, platform, and connection state.", inputSchema: { type: "object", properties: {} } }
] as const;

const agents = new Map<string, Agent>();

function jsonRpc(id: unknown, result: unknown): Response { return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
function jsonRpcError(id: unknown, code: number, message: string, status = 400): Response { return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
function jsonError(c: Context, message: string, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 = 400): Response { return c.json({ error: message }, status); }
function bodyObject(value: unknown): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required"); return value as JsonObject; }
function stringField(body: JsonObject, key: string): string { const value = body[key]; if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`); return value; }
function roleField(value: unknown): WorkspaceRole { if (value !== "owner" && value !== "editor" && value !== "viewer") throw new Error("Invalid workspace role"); return value; }
function userResponse(user: { id: string; email: string; role: GlobalRole }): AuthUser { return { id: user.id, email: user.email, role: user.role }; }
async function sessionFromCookie(c: Context): Promise<SessionRecord | null> { const raw = cookieValue(c.req.header("cookie"), "mt_session"); return raw ? db.findSession(hashToken(raw), Date.now()) : null; }
async function requireUser(c: Context): Promise<AuthUser | null> { const session = await sessionFromCookie(c); return session ? { id: session.userId, email: session.email, role: session.role } : null; }
function isAdmin(user: AuthUser): boolean { return user.role === "admin"; }
async function canManageWorkspace(user: AuthUser, id: string): Promise<boolean> { return isAdmin(user) || (await db.findWorkspaceRole(id, user.id)) === "owner"; }
async function canAccessWorkspace(user: AuthUser, id: string): Promise<boolean> { return isAdmin(user) || (await db.findWorkspaceRole(id, user.id)) !== null; }
function tokenFromRequest(c: Context): string { const authorization = c.req.header("authorization"); if (authorization?.startsWith("Bearer ")) return authorization.slice(7); return c.req.query("token") ?? c.req.param("secret") ?? ""; }

async function callAgent(agent: Agent, tool: Exclude<RelayTool, "workspace_info">, args: unknown): Promise<ToolReply> {
  if (agent.socket.readyState !== WebSocket.OPEN) throw new Error("No VS Code agent is connected");
  // 能力不匹配是工具执行错误；避免 HTTP 502 被公网代理替换，丢失升级提示。
  if (!agent.tools.includes(tool)) return { ok: false, content: "当前 VS Code Agent 不支持此工具，请更新 m-tunnel 插件并重新连接" };
  const id = crypto.randomUUID(); agent.socket.send(JSON.stringify({ type: "tool_call", id, tool, arguments: args }));
  return await new Promise<ToolReply>((resolve, reject) => { const timer = setTimeout(() => { agent.pending.delete(id); reject(new Error("VS Code tool call timed out")); }, 300_000); agent.pending.set(id, { resolve, reject, timer }); });
}

async function bootstrap(database: DatabaseHandle): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase(); let admin = await database.findUserByEmail(email);
  if (!admin) { const password = process.env.ADMIN_PASSWORD ?? (process.env.NODE_ENV === "production" ? "" : "change-me-now"); if (!password) throw new Error("ADMIN_PASSWORD is required for the first production startup"); admin = { id: crypto.randomUUID(), email, passwordHash: hashPassword(password), role: "admin", createdAt: Date.now() }; await database.createUser(admin); console.log(`Created administrator ${email}`); }
  const legacy = process.env.MCP_TOKEN;
  if (legacy && !(await database.findWorkspaceToken(hashToken(legacy)))) {
    const workspaces = await database.listWorkspaces(admin.id, true);
    const workspace = workspaces[0] ?? { id: crypto.randomUUID(), name: "等待 VS Code 连接", ownerId: admin.id, createdAt: Date.now() };
    if (!workspaces[0]) { await database.createWorkspace(workspace); await database.addWorkspaceMember(workspace.id, admin.id, "owner"); }
    await database.createWorkspaceToken({ id: crypto.randomUUID(), workspaceId: workspace.id, tokenHash: hashToken(legacy), prefix: legacy.slice(0, 8), role: "owner", createdAt: Date.now() });
    console.log("Imported MCP_TOKEN into the default workspace");
  }
}
await bootstrap(db);

const app = new Hono();
app.use("/api/*", async (c, next) => { await next(); c.header("cache-control", "no-store"); });
app.options("/mcp/:secret", (c) => new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,GET,OPTIONS", "access-control-allow-headers": "authorization,content-type,mcp-session-id" } }));
app.get("/health", (c) => c.json({ status: "ok", connectedWorkspaces: [...agents.values()].filter((agent) => agent.socket.readyState === WebSocket.OPEN).length }));

app.post("/api/auth/register", async (c) => { try { const body = bodyObject(await c.req.json()); const email = stringField(body, "email").toLowerCase(); const password = stringField(body, "password"); if (await db.findUserByEmail(email)) return jsonError(c, "Email already registered", 409); const user: AuthUser = { id: crypto.randomUUID(), email, role: "member" }; await db.createUser({ ...user, passwordHash: hashPassword(password), createdAt: Date.now() }); return c.json(userResponse(user), 201); } catch (error) { return jsonError(c, error instanceof Error ? error.message : String(error), 422); } });
app.post("/api/auth/login", async (c) => { try { const body = bodyObject(await c.req.json()); const email = stringField(body, "email").toLowerCase(); const password = stringField(body, "password"); const user = await db.findUserByEmail(email); if (!user || !verifyPassword(password, user.passwordHash)) return jsonError(c, "Invalid email or password", 401); const raw = createToken(); await db.createSession({ id: crypto.randomUUID(), userId: user.id, email: user.email, role: user.role, tokenHash: hashToken(raw), expiresAt: Date.now() + SESSION_TTL }); return new Response(JSON.stringify(userResponse(user)), { headers: { "content-type": "application/json", "set-cookie": sessionCookie(raw, SESSION_TTL / 1000) } }); } catch (error) { return jsonError(c, error instanceof Error ? error.message : String(error), 422); } });
app.post("/api/auth/logout", async (c) => { const raw = cookieValue(c.req.header("cookie"), "mt_session"); if (raw) await db.deleteSession(hashToken(raw)); return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie() } }); });
app.get("/api/auth/me", async (c) => { const user = await requireUser(c); return user ? c.json(userResponse(user)) : jsonError(c, "Unauthorized", 401); });

app.get("/api/users", async (c) => { const user = await requireUser(c); if (!user) return jsonError(c, "Unauthorized", 401); if (!isAdmin(user)) return jsonError(c, "Forbidden", 403); return c.json((await db.listUsers()).map((item) => userResponse(item))); });
app.patch("/api/users/:id", async (c) => { const user = await requireUser(c); if (!user) return jsonError(c, "Unauthorized", 401); if (!isAdmin(user)) return jsonError(c, "Forbidden", 403); try { const body = bodyObject(await c.req.json()); const role = body.role; if (role !== "admin" && role !== "member") throw new Error("Invalid global role"); await db.updateUserRole(c.req.param("id"), role); return c.json({ ok: true }); } catch (error) { return jsonError(c, error instanceof Error ? error.message : String(error), 422); } });
app.get("/api/workspaces", async (c) => { const user = await requireUser(c); if (!user) return jsonError(c, "Unauthorized", 401); return c.json(await db.listWorkspaces(user.id, isAdmin(user))); });
app.post("/api/connections", async (c) => {
  const user = await requireUser(c);
  if (!user) return jsonError(c, "Unauthorized", 401);
  const workspace = { id: crypto.randomUUID(), name: "等待 VS Code 连接", ownerId: user.id, createdAt: Date.now() };
  await db.createWorkspace(workspace);
  await db.addWorkspaceMember(workspace.id, user.id, "owner");
  const token = createToken(); const id = crypto.randomUUID();
  await db.createWorkspaceToken({ id, workspaceId: workspace.id, tokenHash: hashToken(token), prefix: token.slice(0, 8), role: "editor", createdAt: Date.now() });
  console.log(JSON.stringify({ event: "connection_created", workspaceId: workspace.id, userId: user.id }));
  return c.json({ id, workspaceId: workspace.id, token }, 201);
});
app.get("/api/workspaces/:id/members", async (c) => { const user = await requireUser(c); const id = c.req.param("id"); if (!user) return jsonError(c, "Unauthorized", 401); if (!(await canAccessWorkspace(user, id))) return jsonError(c, "Forbidden", 403); return c.json(await db.listWorkspaceMembers(id)); });
app.put("/api/workspaces/:id/members/:userId", async (c) => { const user = await requireUser(c); const id = c.req.param("id"); if (!user) return jsonError(c, "Unauthorized", 401); if (!(await canManageWorkspace(user, id))) return jsonError(c, "Forbidden", 403); try { const body = bodyObject(await c.req.json()); await db.addWorkspaceMember(id, c.req.param("userId"), roleField(body.role)); return c.json({ ok: true }); } catch (error) { return jsonError(c, error instanceof Error ? error.message : String(error), 422); } });
app.get("/api/workspaces/:id/tokens", async (c) => { const user = await requireUser(c); const id = c.req.param("id"); if (!user) return jsonError(c, "Unauthorized", 401); if (!(await canAccessWorkspace(user, id))) return jsonError(c, "Forbidden", 403); return c.json(await db.listWorkspaceTokens(id)); });
app.post("/api/workspaces/:id/tokens", async (c) => { const user = await requireUser(c); const id = c.req.param("id"); if (!user) return jsonError(c, "Unauthorized", 401); if (!(await canManageWorkspace(user, id))) return jsonError(c, "Forbidden", 403); try { const body = bodyObject(await c.req.json()); if (body.role !== undefined && body.role !== "editor") throw new Error("Token 不再区分角色，请省略 role"); const role = "editor"; const raw = createToken(); const token = { id: crypto.randomUUID(), workspaceId: id, tokenHash: hashToken(raw), prefix: raw.slice(0, 8), role: "editor" as const, createdAt: Date.now() }; await db.createWorkspaceToken(token); return c.json({ id: token.id, prefix: token.prefix, role, token: raw }, 201); } catch (error) { return jsonError(c, error instanceof Error ? error.message : String(error), 422); } });
app.delete("/api/workspaces/:id/tokens/:tokenId", async (c) => { const user = await requireUser(c); const id = c.req.param("id"); if (!user) return jsonError(c, "Unauthorized", 401); if (!(await canManageWorkspace(user, id))) return jsonError(c, "Forbidden", 403); await db.revokeWorkspaceToken(c.req.param("tokenId"), id, Date.now()); const agent = agents.get(id); if (agent?.tokenId === c.req.param("tokenId")) agent.socket.close(4001, "token_revoked"); return c.json({ ok: true }); });
app.get("/api/status", async (c) => { const user = await requireUser(c); if (!user) return jsonError(c, "Unauthorized", 401); const workspaces = await db.listWorkspaces(user.id, isAdmin(user)); return c.json(workspaces.map((workspace) => { const agent = agents.get(workspace.id); return { ...workspace, agentConnected: agent?.socket.readyState === WebSocket.OPEN, workspacePath: agent?.workspacePath ?? workspace.workspacePath ?? null, platform: agent?.platform ?? workspace.platform ?? null }; })); });
app.get("/api/tool-calls", async (c) => { const user = await requireUser(c); if (!user) return jsonError(c, "Unauthorized", 401); const workspaces = await db.listWorkspaces(user.id, isAdmin(user)); return c.json(await db.listToolCalls(workspaces.map((workspace) => workspace.id))); });
app.get("/api/tool-calls/:id", async (c) => {
  const user = await requireUser(c);
  if (!user) return jsonError(c, "Unauthorized", 401);
  const call = await db.findToolCall(c.req.param("id"));
  if (!call) return jsonError(c, "Not found", 404);
  // 正文可能包含文件和命令输出，详情必须与列表使用同一工作区权限边界。
  if (!isAdmin(user) && (!call.workspace || !(await canAccessWorkspace(user, call.workspace)))) return jsonError(c, "Forbidden", 403);
  return c.json(call);
});

async function mcpRequest(c: Context): Promise<Response> {
  const secret = tokenFromRequest(c); const match = secret ? await db.findWorkspaceToken(hashToken(secret)) : null; if (!match) return c.text("Unauthorized", 401);
  let body: unknown; try { body = await c.req.json(); } catch { return jsonRpcError(null, -32700, "Parse error"); } if (!body || typeof body !== "object") return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  const request = body as { id?: unknown; method?: unknown; params?: unknown }; const id = request.id ?? null;
  if (request.method === "notifications/initialized") return new Response(null, { status: 202 }); if (request.method === "initialize") return jsonRpc(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "m-tunnel", version: "0.2.0" }, instructions: match.token.role === "viewer" ? "此 Token 仅可通过 read 读取工作区文件，通过 workspace_info 查询连接信息。" : "开始任务及切换目标目录时先调用 context_manifest，按顺序用 read_context 读取适用的 AGENTS.md；按需读取去重后的 skills，规则只应用于各自作用域。" }); if (request.method === "ping") return jsonRpc(id, {}); if (request.method === "tools/list") return jsonRpc(id, { tools: match.token.role === "viewer" ? tools.filter((tool) => tool.name === "read" || tool.name === "workspace_info") : tools }); if (request.method !== "tools/call") return jsonRpcError(id, -32601, `Unknown method: ${String(request.method)}`);
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown }; const name = params.name; if (!toolNames.includes(name as RelayTool)) return jsonRpcError(id, -32602, "Unknown tool");
  const agent = agents.get(match.workspace.id); const started = Date.now(); let reply: ToolReply;
  const args = params.arguments ?? {};
  const recordCall = async (status: "success" | "error", result: string | null, error: string | null) => {
    // 上下文含本机私密内容：连错误原文与参数也不能落库，失败只存固定摘要。
    const privateContext = name === "context_manifest" || name === "read_context";
    await db.addToolCall({ id: crypto.randomUUID(), tool: String(name), status, workspace: match.workspace.id, userId: null, durationMs: Date.now() - started, arguments: privateContext ? null : JSON.stringify(args), result: privateContext ? null : result, error: privateContext ? (status === "error" ? "上下文调用失败；原文未保存" : null) : error, createdAt: Date.now() });
  };
  let agentArgs = args;
  if (name === "bash") {
    try {
      const input = bodyObject(args);
      if (input.timeout !== undefined) {
        if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout < 1 || input.timeout > 300) throw new Error("bash timeout must be between 1 and 300 seconds; use 120 for 2 minutes");
        // MCP 使用秒，现有 Agent 使用毫秒；只在边界换算，省略时保留插件配置。
        agentArgs = { ...input, timeout: Math.round(input.timeout * 1000) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordCall("error", null, message); return jsonRpcError(id, -32602, message);
    }
  }
  if (name === "workspace_info") reply = { ok: true, content: JSON.stringify({ workspaceId: match.workspace.id, name: match.workspace.name, root: agent?.workspacePath ?? null, platform: agent?.platform ?? null, connected: agent?.socket.readyState === WebSocket.OPEN, role: match.token.role }) };
  else if (match.token.role === "viewer" && name !== "read") {
    const message = "Workspace token role viewer can only call read and workspace_info";
    await recordCall("error", null, message); return jsonRpcError(id, -32003, message, 403);
  } else if (!agent) {
    const message = "No VS Code agent is connected";
    await recordCall("error", null, message); return jsonRpcError(id, -32000, message, 502);
  } else {
    try { reply = await callAgent(agent, name as Exclude<RelayTool, "workspace_info">, agentArgs); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); await recordCall("error", null, message); return jsonRpcError(id, -32000, message, 502); }
  }
  await recordCall(reply.ok ? "success" : "error", reply.content, reply.ok ? null : reply.content);
  return jsonRpc(id, { content: [{ type: "text", text: reply.content }], isError: !reply.ok });
}
app.get("/mcp/:secret", (c) => c.text("m-tunnel MCP endpoint\n\n", 200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" })); app.post("/mcp/:secret", mcpRequest);

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }) as Server;
attachAgentServer(server, db, agents);
console.log(`m-tunnel API listening on ${port} (${db.driver}, postgres.js when PostgreSQL is configured)`);
