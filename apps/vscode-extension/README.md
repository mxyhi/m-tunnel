# m-tunnel Workspace MCP

将当前 VS Code 文件夹接入 m-tunnel，让 ChatGPT 等支持 MCP 的客户端调用文件和命令工具。

## 连接

1. 在管理台登录并点击“连接 VS Code”，无需手动填写工作区名称。
2. 在 VS Code 中打开目标文件夹，点击管理台的“一键导入 VS Code”。
3. 确认显示的服务地址和文件夹。服务端登记成功后，插件会通知“配置成功，已连接〈文件夹〉”。
4. 在管理台点击“复制 MCP 链接”，填入网页 AI 客户端的 MCP 连接器。

之后随时点击 VS Code 底部的 **m-tunnel**，选择“复制 MCP 链接”。如果浏览器无法打开 VS Code，复制管理台的“VS Code 导入链接”，再运行命令 **m-tunnel: 导入连接**。

Token 按文件夹保存在 VS Code SecretStorage 中。新导入不会写入可提交的 `.vscode/settings.json`；旧 `mTunnel.token` / `mTunnel.relayUrl` 配置仍可读取。一个连接绑定一个文件夹，其他文件夹请在管理台生成新连接。

## 工具与设置

支持 `read`、`bash`、`edit`、`write`、`workspace_info`、`context_manifest` 和 `read_context`。新连接统一提供工具读写能力，不再选择只读 Token。

- `mTunnel.autoStart`：打开工作区后自动连接。
- `mTunnel.bashTimeoutMs`：命令超时，默认 120 秒。
- `mTunnel.contextReadRoots`：额外可读的本机目录，默认 `["~/.codex", "~/.agents"]`，递归允许整个目录；仅用户/远端机器设置生效，空数组关闭外部读取。
- 必须打开可信工作区；导入外部链接时会显示具体服务与文件夹供确认。
- 断网会自动重连；凭据无效、被撤销、绑定错误文件夹或被其他窗口接管时停止重试并显示通知。

扩展 ID：`mxyer.m-tunnel-vscode`。本版本需要支持 `agent_ready` 的新版 m-tunnel 服务端。

## 规则与 skills

先调用 `context_manifest`（可传入目标文件或已有目录 `path`），再用 `read_context` 按顺序读取返回的 AGENTS，按需读取 skill 正文及引用文件：

- 全局优先 `~/.codex/AGENTS.md`，不存在才用 `~/.agents/AGENTS.md`。
- 项目根及沿目标路径的每层 `AGENTS.md` 均叠加，深层规则只在其子树内覆盖冲突。
- 两个来源的 `skills/**/SKILL.md` 递归发现，包括多层和隐藏目录；按 YAML `name`（缺省目录名）去重，`~/.codex` 优先。同源同名按路径顺序取首项。

`read_context` 支持 `~/`、绝对和工作区相对路径，默认读取 400 行，可传 `offset`/`limit` 继续，单文件最大 1 MiB。普通 `read/write/edit` 保持工作区范围；软链接的真实目标也须在对应授权范围内，skills 外链越界会出现在 manifest 的 `warnings` 中。要使用白名单外的共享 skills 链接，可在本机设置中额外加入链接的真实目录。

上下文工具的参数、正文和错误原文不保存到 Relay 调用记录。扩展 v0.1.3 需要配套服务 v0.1.5 并刷新 MCP 工具列表；客户端根据工具提示按需加载上下文。
