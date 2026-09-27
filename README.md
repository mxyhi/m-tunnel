# m-tunnel

把多个 VS Code 工作区通过 MCP 暴露给 ChatGPT、Claude 等网页客户端。VS Code 插件负责在当前工作区执行工具，Hono Relay 负责 HTTPS MCP、WebSocket 路由和权限控制。

## 功能

- `read`、`bash`、`edit`、`write` 和 `workspace_info`
- 多用户、登录会话、全局角色（`admin` / `member`）
- 工作区成员角色（`owner` / `editor` / `viewer`）
- 每个工作区独立 MCP Token，可撤销；数据库只保存哈希
- SQLite 或 PostgreSQL；PostgreSQL 使用 `postgres.js` 连接池
- Docker Compose 和 1Panel 网站代理配置

## 本地开发

```bash
pnpm install
pnpm check
pnpm build
pnpm test
```

启动 API 前设置 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 和 `MCP_TOKEN`。首次启动会创建管理员、默认工作区并迁移旧 Token。生产环境必须显式设置 `ADMIN_PASSWORD`。

## Compose 部署

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
```

`m-tunnel-api` 监听 18290，`m-tunnel-web` 监听 18291。将 `deploy/1panel-proxy-root.conf` 放到 1Panel 站点的 `proxy/root.conf`，再由 HTTPS 站点代理 `/api/`、`/mcp/`、`/agent/` 和管理台。

管理台登录后创建工作区 Token：

```text
https://your-domain.example/mcp/<WORKSPACE_TOKEN>
wss://your-domain.example/agent/<WORKSPACE_TOKEN>
```

不要提交 `.env`、数据库文件、Token、密码、Cookie 或构建产物；这些路径已在 `.gitignore` 中排除。

## 发布 VS Code 插件

插件发布工作流使用 VS Code Marketplace 的 OIDC Trusted Publishing，不需要把 PAT 存进 GitHub。先在 Marketplace 发布者设置中将 `mxyhi/m-tunnel` 绑定为可信发布仓库，然后创建版本标签：

```bash
git tag vscode-v0.1.1
git push origin vscode-v0.1.1
```
