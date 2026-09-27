# m-tunnel 管理端

使用 [Marmelab Shadcn Admin Kit](https://github.com/marmelab/shadcn-admin-kit)，由 `ra-core` 提供认证、资源路由、数据查询和表单控制，由官方 Kit 与 shadcn/ui 提供界面。入口实际渲染 `Admin` 和 `Resource`，工作区、用户、调用记录使用 `List` / `DataTable`，用户角色编辑使用 `SimpleForm`。

## 组件来源

`src/components/admin`、`src/components/ui` 及相关 hooks/lib 来自官方提交 `d3a021d738910ad21dd2429c6cff49f54c5facd2`，仅引入当前页面需要的依赖闭包。MIT 许可保存在 `SHADCN-ADMIN-KIT-LICENSE`。本地调整包括中文文案、m-tunnel 品牌、消除显式 `any` 和严格索引检查适配。前端保留 `strict` 与 `noUncheckedIndexedAccess`，为适配上游组件传递可选 props，单独关闭 `exactOptionalPropertyTypes`。

## API 适配

- `authProvider` 使用现有 HttpOnly Cookie 会话；401 结束会话，403 作为权限错误展示。
- `dataProvider` 将现有数组接口适配为 React Admin 分页/排序协议。当前为内存分页，数据规模扩大时应升级服务端分页。
- 工作区状态从 `/api/status` 获取；成员和 Token 使用工作区内的嵌套资源。
- 用户角色修改使用悲观提交；Token 写操作成功后刷新列表。Token 明文只存在当前详情页内存，切换工作区、离开详情或点击隐藏后清除。
- 全局用户资源只对管理员注册；工作区 Token 写按钮只对管理员或 owner 显示，最终权限由 API 校验。

## 本地运行与验证

```bash
pnpm --filter @m-tunnel/admin dev
pnpm --filter @m-tunnel/admin typecheck
pnpm --filter @m-tunnel/admin build
pnpm --filter @m-tunnel/admin test
```

开发服务器默认代理 `/api` 至 `http://127.0.0.1:18290`，可通过 `ADMIN_API_TARGET` 指定隔离测试 API。浏览器仍使用同源 Cookie。

## 自动接入流程

列表入口改为“连接 VS Code”，通过 `/api/connections` 自动准备待连接工作区和完整工具权限凭据。插件上报当前文件夹后，服务端持久化其名称、路径和绑定身份；只有登记完成并回复 `agent_ready` 后才显示在线。

连接信息卡提供 MCP 链接复制、VS Code URI 导入、备用导入链接与 Token 复制。原文只留在当前页面内存；之后可从插件的 SecretStorage 中复制 MCP 链接。旧 Token 无法从前缀还原，不能为历史行伪造复制链接。

新 Token 不再接受 viewer/owner 角色选项；已有只读 Token 的权限不变，以免静默扩张为 shell 执行权限。工作区成员权限仍保持原有 owner/editor/viewer 定义。
