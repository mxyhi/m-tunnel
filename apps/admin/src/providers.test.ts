import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { authProvider, dataProvider, request } from "./providers.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("工作区从状态接口获取，按数字排序后分页，并携带会话", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/status");
    assert.equal(init?.credentials, "include");
    return Response.json([{ id: "a", createdAt: 3, agentConnected: true }, { id: "b", createdAt: 20, agentConnected: false }, { id: "c", createdAt: 10, agentConnected: true }]);
  };
  const result = await dataProvider.getList("workspaces", { pagination: { page: 2, perPage: 1 }, sort: { field: "createdAt", order: "DESC" }, filter: {} });
  assert.deepEqual(result, { data: [{ id: "c", createdAt: 10, agentConnected: true }], total: 3 });
});

test("嵌套成员资源使用 userId 作为 React Admin 主键", async () => {
  globalThis.fetch = async (input) => {
    assert.equal(input, "/api/workspaces/w1/members");
    return Response.json([{ userId: "u1", email: "viewer@example.test", role: "viewer" }]);
  };
  const result = await dataProvider.getList("workspaces/w1/members", { filter: {} });
  assert.equal(result.data[0]?.id, "u1");
});

test("退出登录支持空的 204 响应", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/auth/logout"); assert.equal(init?.method, "POST");
    return new Response(null, { status: 204 });
  };
  await authProvider.logout({});
});

test("会话过期触发退出，403 权限错误保留登录", async () => {
  globalThis.fetch = async () => Response.json({ error: "Unauthorized" }, { status: 401 });
  await assert.rejects(request("/api/auth/me"), { status: 401, message: "Unauthorized" });
  await assert.rejects(authProvider.checkError({ status: 401 }));
  await authProvider.checkError({ status: 403 });
});

test("用户角色更新只发送 role，返回完整记录供表单更新", async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/users/u1"); assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init?.body)), { role: "member" });
    return Response.json({ ok: true });
  };
  const result = await dataProvider.update("users", { id: "u1", data: { role: "member" }, previousData: { id: "u1", email: "user@example.test", role: "admin" } });
  assert.deepEqual(result.data, { id: "u1", email: "user@example.test", role: "member" });
});

test("普通用户没有全局用户管理权限", async () => {
  globalThis.fetch = async () => Response.json({ id: "u1", email: "user@example.test", role: "member" });
  assert.equal(await authProvider.canAccess?.({ resource: "users", action: "list" }), false);
  assert.equal(await authProvider.getPermissions?.({}), "member");
});
