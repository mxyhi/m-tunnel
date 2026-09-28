# m-tunnel

把多个 VS Code 工作区通过 MCP 暴露给 ChatGPT、Claude 等网页客户端。VS Code 插件负责在当前工作区执行工具，Hono Relay 负责 HTTPS MCP、WebSocket 路由和权限控制。

## 功能

- `read`、`bash`、`edit`、`write`、`workspace_info`、`context_manifest` 和 `read_context`
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

## 命令超时

从 v0.1.3 开始，MCP `bash` 的 `timeout` 明确以秒为单位，范围为 1–300；例如 `{"command":"pnpm build","timeout":120}` 允许执行 2 分钟。省略时使用 VS Code 的 `mTunnel.bashTimeoutMs` 配置，默认 120 秒。Relay 将秒数换算为现有插件所需的毫秒，无需更新插件。

旧版 MCP 参数未标明单位，直接按毫秒执行，容易把 `60` 或 `120` 压到最低 1 秒。原先手动传毫秒的客户端需改传秒，并刷新工具定义；超出范围的值会被拒绝，不会执行命令。

## 本机规则与 skills

开始任务或切换目标目录时，先调用 `context_manifest`，例如 `{"path":"apps/api/src/server.ts"}`。`path` 支持工作区内的文件（可尚未创建）或已有目录，省略时为项目根。返回值仅包含来源、作用域和技能元数据，不包含规则或 skill 正文。

规则按以下顺序读取并组合：

1. `~/.codex/AGENTS.md`；仅该文件不存在时回退至 `~/.agents/AGENTS.md`。存在但无法读取时返回错误。
2. 项目根 `AGENTS.md`。
3. 沿目标路径逐层出现的 `AGENTS.md`。例如 `apps/AGENTS.md`、`apps/api/AGENTS.md`、`apps/api/src/AGENTS.md`。

项目规则不按文件名去重。不同层级叠加，同一事项冲突时深层规则优先且只作用于其子树；兄弟目录和工作区祖先目录不会自动纳入。项目内软链接按真实目标路径收集规则，manifest 的 `target` 返回规范后的目标。

skills 递归扫描 `~/.codex/skills/**/SKILL.md` 和 `~/.agents/skills/**/SKILL.md`，包括 `.system` 等隐藏目录以及 skill 内的嵌套 skill。名称取 YAML frontmatter 的 `name`，缺省取父目录名；按完整名称区分大小写去重，固定 `~/.codex` 优先，同源按路径顺序选首项。支持 YAML 引号与多行描述；索引只解析最多 64 KiB 的头部，正文按需读取。扫描跳过 `.git`、`node_modules`，超过 10000 项会报错；格式错误或越界软链接会在 manifest 的 `warnings` 中列出。

按 manifest 中的顺序通过 `read_context` 读取规则，选中 skill 后再读取正文及其引用文件：

```json
{"path":"~/.codex/AGENTS.md"}
```

```json
{"path":"~/.agents/skills/team/frontend/react/SKILL.md","offset":1,"limit":400}
```

`read_context` 支持工作区相对路径、绝对路径、`~/`，以及 `offset`（从 1 开始）和 `limit`（1–1000 行，默认 400）。单文件上限 1 MiB，只读取普通文件。它提供完整授权根的读取能力，既不限于 `skills`/`memories`，也不负责执行读取到的脚本。

VS Code 用户或远端机器设置：

```json
{
  "mTunnel.contextReadRoots": ["~/.codex", "~/.agents"]
}
```

`~` 指扩展运行机器的用户目录。设置为空数组可关闭外部读取；工作区自身仍可读。配置不会被仓库 `.vscode/settings.json` 覆写。其他根可显式加入白名单供 `read_context` 读取，自动规则/skills 发现仍来自上述两个固定来源及当前项目。

路径同时检查词法边界和真实软链接目标。软链接可以指向另一个已授权根；指向白名单外的共享 skills 仓库时会跳过并提示，需显式授权其真实目录后才能读取。普通 `read/write/edit` 始终检查工作区边界，不能通过链接访问外部上下文目录。`bash` 仍按扩展进程的用户权限执行，读取根配置不构成命令沙箱。

两个上下文工具仅允许 owner/editor Token。Relay 不保存它们的参数、返回正文或错误原文，只记录工具、状态、耗时和固定失败摘要；普通工具的调用记录策略不变。MCP 初始化说明与工具描述会提示上述读取流程，客户端仍需实际调用工具，不会自动向任意客户端注入整份上下文。

此功能随服务 v0.1.5、VS Code 扩展 v0.1.3 发布，需要同时更新并刷新客户端工具定义。旧插件继续支持原四个执行工具；调用新工具会立即提示升级，不再等待超时。无需数据库迁移。
