# m-tunnel

把多个 VS Code 工作区通过 MCP 暴露给 ChatGPT、Claude 等网页客户端。VS Code 插件负责在当前工作区执行工具，Hono Relay 负责 HTTPS MCP、WebSocket 路由和权限控制。

## 功能

- `read`、`bash`、`edit`、`write` 和 `workspace_info`
- 多用户、登录会话、全局角色（`admin` / `member`）
- 工作区成员角色（`owner` / `editor` / `viewer`）
- 每个工作区独立 MCP Token，可撤销；数据库只保存哈希
- SQLite 或 PostgreSQL；PostgreSQL 使用 `postgres.js` 连接池
- 调用记录详情：参数、返回内容、错误和耗时，按工作区成员权限查看
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

管理台登录后点击“连接 VS Code”，生成连接信息：

```text
https://your-domain.example/mcp/<WORKSPACE_TOKEN>
wss://your-domain.example/agent/<WORKSPACE_TOKEN>
```

不要提交 `.env`、数据库文件、Token、密码、Cookie 或构建产物；这些路径已在 `.gitignore` 中排除。

## 发布 VS Code 插件

插件发布者 ID 为 `mxyer`，扩展 ID 为 `mxyer.m-tunnel-vscode`（GitHub 仓库仍为 `mxyhi/m-tunnel`）。可在 Marketplace 管理台上传 VSIX 发布。

仓库已提供 OIDC Trusted Publishing 工作流，但 Marketplace 端的可信发布绑定尚未验证完成。启用自动发布前，需要将发布者与 `mxyhi/m-tunnel` 的 `.github/workflows/publish-vscode.yml` 绑定，再创建版本标签：

```bash
git tag vscode-v0.1.2
git push origin vscode-v0.1.2
```

## 管理台连接 VS Code

管理台使用官方 [Marmelab Shadcn Admin Kit](https://github.com/marmelab/shadcn-admin-kit)。登录后点击“连接 VS Code”，在 VS Code 打开目标文件夹并一键导入；工作区名称由插件自动登记。管理台提供 MCP 链接复制，插件登记成功后显示通知，也可从状态栏菜单随时复制链接。

新连接统一拥有工具读写能力。升级时需同时更新 API、管理台与 VS Code 插件至 0.1.2；旧只读凭据继续受原权限限制。服务端保留 Token 哈希，插件将新导入的凭据按工作区保存在 SecretStorage。

## 调用记录详情

点击调用记录行或“查看详情”可查看参数、返回内容和错误。升级 API 与管理台后，新调用会保存正文（包括命令、文件内容和输出）；SQLite/PostgreSQL 启动时自动补充详情字段。旧记录的正文无法补回，详情页显示未保存；本次功能无需更新 VS Code 插件。
