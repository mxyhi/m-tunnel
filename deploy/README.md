# 1Panel 部署

在 1Panel 的「容器 > Docker Compose」中选择本目录，1Panel 会识别 `docker-compose.yml`。首次部署前复制 `.env.example` 为 `.env`，设置 `MCP_TOKEN`、`ADMIN_EMAIL` 和 `ADMIN_PASSWORD`，然后启动或重建项目。Compose 会同时启动 API 和管理台 Web 容器。

网站使用 1Panel 的标准站点目录：

- 站点：`mtunnel.mxyhi.com`
- 站点根目录：`/www/sites/mtunnel.mxyhi.com/index`
- 代理配置：`/www/sites/mtunnel.mxyhi.com/proxy/root.conf`
- Compose API：`127.0.0.1:18290`
- Compose 管理台：`127.0.0.1:18291`

`nginx-mtunnel.conf` 是 1Panel 网站主配置模板，主配置通过 `proxy/*.conf` 引入代理规则。`1panel-proxy-root.conf` 可作为该站点的 `proxy/root.conf` 内容。

登录管理台后点击“连接 VS Code”，复制 MCP 链接或一键导入 VS Code。工作区名称由插件自动登记，无需手动创建。MCP 地址格式：

```text
https://mtunnel.mxyhi.com/mcp/<WORKSPACE_TOKEN>
```

VS Code Agent 使用同一 token 连接：

```text
wss://mtunnel.mxyhi.com/agent/<WORKSPACE_TOKEN>
```
