import { createClient, type Client } from "@libsql/client";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pgTable, integer as pgInteger, text as pgText } from "drizzle-orm/pg-core";
import postgres from "postgres";

export type GlobalRole = "admin" | "member";
export type WorkspaceRole = "owner" | "editor" | "viewer";

export interface UserRecord { id: string; email: string; passwordHash: string; role: GlobalRole; createdAt: number }
export interface SessionRecord { id: string; userId: string; email: string; role: GlobalRole; tokenHash: string; expiresAt: number }
export interface WorkspaceRecord { id: string; name: string; ownerId: string; createdAt: number; workspacePath?: string | null; platform?: string | null; registeredAt?: number | null }
export interface WorkspaceMemberRecord { workspaceId: string; userId: string; email: string; role: WorkspaceRole }
export interface WorkspaceTokenRecord { id: string; workspaceId: string; prefix: string; role: WorkspaceRole; createdAt: number; revokedAt: number | null }
export interface WorkspaceTokenMatch { workspace: WorkspaceRecord; token: WorkspaceTokenRecord }
export interface ToolCallRecord { id: string; tool: string; status: string; workspace: string | null; userId: string | null; durationMs: number | null; error: string | null; createdAt: number }

const sqliteToolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(), tool: text("tool").notNull(), status: text("status").notNull(), workspace: text("workspace"), userId: text("user_id"), durationMs: integer("duration_ms"), error: text("error"), createdAt: integer("created_at").notNull()
});
const postgresToolCalls = pgTable("tool_calls", {
  id: pgText("id").primaryKey(), tool: pgText("tool").notNull(), status: pgText("status").notNull(), workspace: pgText("workspace"), userId: pgText("user_id"), durationMs: pgInteger("duration_ms"), error: pgText("error"), createdAt: pgInteger("created_at").notNull()
});

type SqlArg = string | number | null;
type SqlRow = Record<string, unknown>;
type QueryRows = { rows: SqlRow[] };

export interface DatabaseHandle {
  readonly driver: "sqlite" | "postgres";
  countUsers(): Promise<number>;
  createUser(user: UserRecord): Promise<void>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  updateUserRole(id: string, role: GlobalRole): Promise<void>;
  createSession(session: SessionRecord): Promise<void>;
  findSession(tokenHash: string, now: number): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  createWorkspace(workspace: WorkspaceRecord): Promise<void>;
  listWorkspaces(userId: string, isAdmin: boolean): Promise<WorkspaceRecord[]>;
  findWorkspace(id: string): Promise<WorkspaceRecord | null>;
  registerWorkspaceAgent(id: string, bindingKey: string, name: string, path: string, platform: string): Promise<boolean>;
  addWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>;
  findWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  createWorkspaceToken(token: { id: string; workspaceId: string; tokenHash: string; prefix: string; role: WorkspaceRole; createdAt: number }): Promise<void>;
  listWorkspaceTokens(workspaceId: string): Promise<WorkspaceTokenRecord[]>;
  revokeWorkspaceToken(id: string, workspaceId: string, revokedAt: number): Promise<void>;
  findWorkspaceToken(tokenHash: string): Promise<WorkspaceTokenMatch | null>;
  addToolCall(row: ToolCallRecord): Promise<void>;
  listToolCalls(workspaceIds?: readonly string[]): Promise<ToolCallRecord[]>;
}

function valueString(row: SqlRow, key: string): string { const value = row[key]; if (typeof value !== "string") throw new Error(`Invalid database value: ${key}`); return value; }
function valueNumber(row: SqlRow | undefined, key: string): number { if (!row) throw new Error(`Missing database row: ${key}`); const value = row[key]; if (typeof value === "number") return value; if (typeof value === "bigint") return Number(value); if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value); throw new Error(`Invalid database value: ${key}`); }
function valueNullableNumber(row: SqlRow, key: string): number | null { const value = row[key]; return value === null || value === undefined ? null : typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null; }
function globalRole(value: string): GlobalRole { if (value !== "admin" && value !== "member") throw new Error(`Invalid global role: ${value}`); return value; }
function workspaceRole(value: string): WorkspaceRole { if (value !== "owner" && value !== "editor" && value !== "viewer") throw new Error(`Invalid workspace role: ${value}`); return value; }
function mapUser(row: SqlRow): UserRecord { return { id: valueString(row, "id"), email: valueString(row, "email"), passwordHash: valueString(row, "password_hash"), role: globalRole(valueString(row, "role")), createdAt: valueNumber(row, "created_at") }; }
function mapWorkspace(row: SqlRow): WorkspaceRecord { return { id: valueString(row, "id"), name: valueString(row, "name"), ownerId: valueString(row, "owner_id"), createdAt: valueNumber(row, "created_at"), workspacePath: typeof row.workspace_path === "string" ? row.workspace_path : null, platform: typeof row.platform === "string" ? row.platform : null, registeredAt: valueNullableNumber(row, "registered_at") }; }
function mapToken(row: SqlRow): WorkspaceTokenRecord { return { id: valueString(row, "id"), workspaceId: valueString(row, "workspace_id"), prefix: valueString(row, "token_prefix"), role: workspaceRole(valueString(row, "role")), createdAt: valueNumber(row, "created_at"), revokedAt: valueNullableNumber(row, "revoked_at") }; }
function mapToolCall(row: SqlRow): ToolCallRecord { return { id: valueString(row, "id"), tool: valueString(row, "tool"), status: valueString(row, "status"), workspace: typeof row.workspace === "string" ? row.workspace : null, userId: typeof row.user_id === "string" ? row.user_id : null, durationMs: valueNullableNumber(row, "duration_ms"), error: typeof row.error === "string" ? row.error : null, createdAt: valueNumber(row, "created_at") }; }

function postgresPlaceholders(sql: string): string { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); }

async function ensureSchema(run: (sql: string, args?: readonly SqlArg[]) => Promise<QueryRows>): Promise<void> {
  await run("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at BIGINT NOT NULL)");
  await run("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)");
  await run("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, created_at BIGINT NOT NULL)");
  await run("CREATE TABLE IF NOT EXISTS workspace_agents (workspace_id TEXT PRIMARY KEY, binding_key TEXT NOT NULL, workspace_path TEXT NOT NULL, platform TEXT NOT NULL, registered_at BIGINT NOT NULL)");
  await run("CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id))");
  await run("CREATE TABLE IF NOT EXISTS workspace_tokens (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'editor', created_at BIGINT NOT NULL, revoked_at BIGINT)");
  await run("CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL, workspace TEXT, user_id TEXT, duration_ms INTEGER, error TEXT, created_at BIGINT NOT NULL)");
  try { await run("ALTER TABLE tool_calls ADD COLUMN user_id TEXT"); } catch { /* existing schema already migrated */ }
  try { await run("ALTER TABLE workspace_tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'"); } catch { /* existing schema already migrated */ }
  await run("CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash)");
  await run("CREATE INDEX IF NOT EXISTS workspace_tokens_hash_idx ON workspace_tokens(token_hash)");
  await run("CREATE INDEX IF NOT EXISTS tool_calls_workspace_idx ON tool_calls(workspace)");
}

export async function createDatabase(): Promise<DatabaseHandle> {
  const url = process.env.DATABASE_URL;
  if (url?.startsWith("postgres://") || url?.startsWith("postgresql://")) {
    const client = postgres(url, { max: Number(process.env.DB_POOL_SIZE ?? 10), idle_timeout: 30 });
    const run = async (sql: string, args: readonly SqlArg[] = []): Promise<QueryRows> => { const result = await client.unsafe<SqlRow[]>(postgresPlaceholders(sql), [...args]); return { rows: result }; };
    await ensureSchema(run);
    return createHandle("postgres", run, client);
  }
  const file = process.env.DB_FILE ?? "./data/m-tunnel.sqlite";
  const client: Client = createClient({ url: file.startsWith("file:") ? file : `file:${file}` });
  const run = async (sql: string, args: readonly SqlArg[] = []): Promise<QueryRows> => { const result = await client.execute({ sql, args: [...args] }); return { rows: result.rows.map((row) => row as unknown as SqlRow) }; };
  await ensureSchema(run);
  const db = drizzleSqlite(client);
  return createHandle("sqlite", run, db);
}

function createHandle(driver: "sqlite" | "postgres", run: (sql: string, args?: readonly SqlArg[]) => Promise<QueryRows>, _drizzle: unknown): DatabaseHandle {
  return {
    driver,
    countUsers: async () => valueNumber((await run("SELECT COUNT(*) AS count FROM users")).rows[0], "count"),
    createUser: async (user) => { await run("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)", [user.id, user.email, user.passwordHash, user.role, user.createdAt]); },
    findUserByEmail: async (email) => { const rows = (await run("SELECT id, email, password_hash, role, created_at FROM users WHERE email = ? LIMIT 1", [email.toLowerCase()])).rows; return rows[0] ? mapUser(rows[0]) : null; },
    findUserById: async (id) => { const rows = (await run("SELECT id, email, password_hash, role, created_at FROM users WHERE id = ? LIMIT 1", [id])).rows; return rows[0] ? mapUser(rows[0]) : null; },
    listUsers: async () => (await run("SELECT id, email, password_hash, role, created_at FROM users ORDER BY created_at DESC")).rows.map(mapUser),
    updateUserRole: async (id, role) => { await run("UPDATE users SET role = ? WHERE id = ?", [role, id]); },
    createSession: async (session) => { await run("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)", [session.id, session.userId, session.tokenHash, session.expiresAt, Date.now()]); },
    findSession: async (tokenHash, now) => { const rows = (await run("SELECT s.id, s.user_id, u.email, u.role, s.token_hash, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1", [tokenHash, now])).rows; if (!rows[0]) return null; return { id: valueString(rows[0], "id"), userId: valueString(rows[0], "user_id"), email: valueString(rows[0], "email"), role: globalRole(valueString(rows[0], "role")), tokenHash: valueString(rows[0], "token_hash"), expiresAt: valueNumber(rows[0], "expires_at") }; },
    deleteSession: async (tokenHash) => { await run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]); },
    createWorkspace: async (workspace) => { await run("INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)", [workspace.id, workspace.name, workspace.ownerId, workspace.createdAt]); },
    listWorkspaces: async (userId, isAdmin) => {
      const fields = "w.id, w.name, w.owner_id, w.created_at, a.workspace_path, a.platform, a.registered_at";
      const rows = (await run(isAdmin
        ? `SELECT ${fields} FROM workspaces w LEFT JOIN workspace_agents a ON a.workspace_id = w.id ORDER BY w.created_at DESC`
        : `SELECT ${fields} FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id LEFT JOIN workspace_agents a ON a.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at DESC`, isAdmin ? [] : [userId])).rows;
      return rows.map(mapWorkspace);
    },
    findWorkspace: async (id) => { const rows = (await run("SELECT id, name, owner_id, created_at FROM workspaces WHERE id = ? LIMIT 1", [id])).rows; return rows[0] ? mapWorkspace(rows[0]) : null; },
    registerWorkspaceAgent: async (id, bindingKey, name, path, platform) => {
      // A credential stays bound to one VS Code folder, even after relay restarts.
      await run("INSERT INTO workspace_agents (workspace_id, binding_key, workspace_path, platform, registered_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id) DO NOTHING", [id, bindingKey, path, platform, Date.now()]);
      const row = (await run("SELECT binding_key FROM workspace_agents WHERE workspace_id = ?", [id])).rows[0];
      if (!row) return false;
      if (row.binding_key !== bindingKey) {
        // Old clients only sent platform/path. Upgrade that binding once, without
        // allowing a new credential import to move an already identified folder.
        if (row.binding_key !== `${platform}:${path}`) return false;
        await run("UPDATE workspace_agents SET binding_key = ? WHERE workspace_id = ? AND binding_key = ?", [bindingKey, id, row.binding_key]);
        const current = (await run("SELECT binding_key FROM workspace_agents WHERE workspace_id = ?", [id])).rows[0];
        if (current?.binding_key !== bindingKey) return false;
      }
      await run("UPDATE workspaces SET name = ? WHERE id = ?", [name, id]);
      await run("UPDATE workspace_agents SET workspace_path = ?, platform = ? WHERE workspace_id = ?", [path, platform, id]);
      return true;
    },
    addWorkspaceMember: async (workspaceId, userId, role) => { await run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role", [workspaceId, userId, role]); },
    listWorkspaceMembers: async (workspaceId) => (await run("SELECT m.workspace_id, m.user_id, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.email", [workspaceId])).rows.map((row) => ({ workspaceId: valueString(row, "workspace_id"), userId: valueString(row, "user_id"), email: valueString(row, "email"), role: workspaceRole(valueString(row, "role")) })),
    findWorkspaceRole: async (workspaceId, userId) => { const rows = (await run("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? LIMIT 1", [workspaceId, userId])).rows; return rows[0] ? workspaceRole(valueString(rows[0], "role")) : null; },
    createWorkspaceToken: async (token) => { await run("INSERT INTO workspace_tokens (id, workspace_id, token_hash, token_prefix, role, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)", [token.id, token.workspaceId, token.tokenHash, token.prefix, token.role, token.createdAt]); },
    listWorkspaceTokens: async (workspaceId) => (await run("SELECT id, workspace_id, token_prefix, role, created_at, revoked_at FROM workspace_tokens WHERE workspace_id = ? ORDER BY created_at DESC", [workspaceId])).rows.map(mapToken),
    revokeWorkspaceToken: async (id, workspaceId, revokedAt) => { await run("UPDATE workspace_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ?", [revokedAt, id, workspaceId]); },
    findWorkspaceToken: async (tokenHash) => { const rows = (await run("SELECT w.id, w.name, w.owner_id, w.created_at, t.id AS token_id, t.workspace_id, t.token_prefix, t.role, t.created_at AS token_created_at, t.revoked_at FROM workspace_tokens t JOIN workspaces w ON w.id = t.workspace_id WHERE t.token_hash = ? AND t.revoked_at IS NULL LIMIT 1", [tokenHash])).rows; if (!rows[0]) return null; const row = rows[0]; return { workspace: { id: valueString(row, "id"), name: valueString(row, "name"), ownerId: valueString(row, "owner_id"), createdAt: valueNumber(row, "created_at") }, token: { id: valueString(row, "token_id"), workspaceId: valueString(row, "workspace_id"), prefix: valueString(row, "token_prefix"), role: workspaceRole(valueString(row, "role")), createdAt: valueNumber(row, "token_created_at"), revokedAt: valueNullableNumber(row, "revoked_at") } }; },
    addToolCall: async (row) => { await run("INSERT INTO tool_calls (id, tool, status, workspace, user_id, duration_ms, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [row.id, row.tool, row.status, row.workspace, row.userId, row.durationMs, row.error, row.createdAt]); },
    listToolCalls: async (workspaceIds) => { if (workspaceIds && workspaceIds.length === 0) return []; const filter = workspaceIds && workspaceIds.length > 0 ? ` WHERE workspace IN (${workspaceIds.map(() => "?").join(",")})` : ""; const rows = (await run(`SELECT id, tool, status, workspace, user_id, duration_ms, error, created_at FROM tool_calls${filter} ORDER BY created_at DESC LIMIT 100`, workspaceIds ? [...workspaceIds] : [])).rows; return rows.map(mapToolCall); }
  };
}
