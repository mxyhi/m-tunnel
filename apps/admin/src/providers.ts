import { defaultDataProvider, HttpError, type AuthProvider, type DataProvider, type RaRecord, type GetListParams, type GetOneParams, type GetManyParams, type UpdateParams, } from "ra-core";

export type User = { id: string; email: string; role: "admin" | "member" };
export type Workspace = { id: string; name: string; ownerId: string; agentConnected: boolean; workspacePath: string | null; platform: string | null; registeredAt?: number | null };
export type Member = { id: string; userId: string; email: string; role: "owner" | "editor" | "viewer" };
export type Token = { id: string; prefix: string; role: Member["role"]; createdAt: number; revokedAt: number | null };
export type ToolCallDetail = { id: string; tool: string; status: string; workspace: string | null; userId: string | null; durationMs: number | null; error: string | null; createdAt: number; arguments: string | null; result: string | null };
type ApiRecord = RaRecord & Record<string, unknown>;

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`${import.meta.env?.VITE_API_URL ?? ""}${path}`, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new HttpError(message, response.status);
  }
  // Logout deliberately returns 204; it must not be parsed as JSON.
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export const authProvider: AuthProvider = {
  login: async ({ email, password }: { email: string; password: string }) => { await request<User>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); },
  logout: async () => { await request<void>("/api/auth/logout", { method: "POST" }); },
  checkAuth: async () => { await request<User>("/api/auth/me"); },
  checkError: async (error: { status?: number }) => { if (error.status === 401) throw error; },
  getIdentity: async () => { const user = await request<User>("/api/auth/me"); return { ...user, fullName: user.email }; },
  getPermissions: async () => (await request<User>("/api/auth/me")).role,
  canAccess: async ({ resource }) => resource !== "users" || (await request<User>("/api/auth/me")).role === "admin",
};

async function records(resource: string, signal?: AbortSignal): Promise<ApiRecord[]> {
  if (!["workspaces", "users", "tool-calls"].includes(resource) && !/^workspaces\/[^/]+\/(members|tokens)$/.test(resource)) throw new Error(`不支持的资源：${resource}`);
  const rows = await request<ApiRecord[]>(resource === "workspaces" ? "/api/status" : `/api/${resource}`, signal ? { signal } : undefined);
  return resource.endsWith("/members") ? rows.map((row) => ({ ...row, id: String(row.userId) })) : rows;
}

export const dataProvider: DataProvider = {
  ...defaultDataProvider,
  // The existing API returns complete arrays. Keep the API contract and adapt
  // sorting/pagination here; add server pagination when collection size warrants it.
  getList: async <RecordType extends RaRecord = RaRecord>(resource: string, { pagination, sort, signal }: GetListParams & { signal?: AbortSignal }) => {
    let data = await records(resource, signal);
    if (sort) {
      const { field, order } = sort;
      data = [...data].sort((a, b) => {
        const left = a[field]; const right = b[field];
        const result = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), "zh-CN", { numeric: true });
        return order === "ASC" ? result : -result;
      });
    }
    const total = data.length;
    if (pagination) data = data.slice((pagination.page - 1) * pagination.perPage, pagination.page * pagination.perPage);
    return { data: data as RecordType[], total };
  },
  getOne: async <RecordType extends RaRecord = RaRecord>(resource: string, { id, signal }: GetOneParams & { signal?: AbortSignal }) => {
    if (resource === "tool-calls") return { data: await request<RecordType>(`/api/tool-calls/${encodeURIComponent(id)}`, signal ? { signal } : undefined) };
    const data = (await records(resource, signal)).find((row) => String(row.id) === String(id));
    if (!data) throw new HttpError("记录不存在或无权访问", 404);
    return { data: data as RecordType };
  },
  getMany: async <RecordType extends RaRecord = RaRecord>(resource: string, { ids, signal }: GetManyParams & { signal?: AbortSignal }) => ({ data: (await records(resource, signal)).filter((row) => ids.some((id) => String(id) === String(row.id))) as RecordType[] }),
  update: async <RecordType extends RaRecord = RaRecord>(resource: string, { id, data, previousData }: UpdateParams<RecordType>) => {
    if (resource !== "users") throw new Error("不支持此更新操作");
    await request(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ role: data.role }) });
    return { data: { ...previousData, ...data, id } as RecordType };
  },
};
