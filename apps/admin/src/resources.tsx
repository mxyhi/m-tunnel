import { useState } from "react";
import { required, useGetIdentity, useGetList, useNotify, useRecordContext, useRefresh } from "ra-core";
import { List } from "@/components/admin/list";
import { DataTable } from "@/components/admin/data-table";
import { Show } from "@/components/admin/show";
import { ShowButton } from "@/components/admin/show-button";
import { Edit } from "@/components/admin/edit";
import { SimpleForm } from "@/components/admin/simple-form";
import { TextInput } from "@/components/admin/text-input";
import { SelectInput } from "@/components/admin/select-input";
import { DateField } from "@/components/admin/date-field";
import { ReferenceField } from "@/components/admin/reference-field";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectionLinks, type Connection } from "./connection-links";
import { request, type Member, type Token, type User, type Workspace } from "./providers";

const roles = [{ id: "admin", name: "管理员" }, { id: "member", name: "普通用户" }];
const workspaceRoles = { owner: "所有者", editor: "编辑者", viewer: "只读" };

export function WorkspaceList() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pending, setPending] = useState(false);
  const notify = useNotify();
  const refresh = useRefresh();
  const connect = async () => {
    setPending(true);
    try { setConnection(await request<Connection>("/api/connections", { method: "POST" })); refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : "创建连接失败", { type: "error" }); }
    finally { setPending(false); }
  };
  return <>
    <p className="text-sm text-muted-foreground my-4">连接 VS Code 后自动登记当前文件夹，无需手动创建工作区。</p>
    {connection && <ConnectionLinks connection={connection} onHide={() => setConnection(null)} />}
    <List title="工作区" queryOptions={{ refetchInterval: 5000 }} exporter={false} actions={<Button disabled={pending} onClick={() => void connect()}>连接 VS Code</Button>}>
      <DataTable<Workspace> rowClick="show" bulkActionButtons={false}>
        <DataTable.Col source="name" label="名称" />
        <DataTable.Col source="agentConnected" label="Agent 状态" render={(record) => <Badge variant={record.agentConnected ? "default" : "secondary"}>{record.agentConnected ? "在线" : record.registeredAt ? "离线" : "待连接"}</Badge>} />
        <DataTable.Col source="workspacePath" label="工作区路径" />
        <DataTable.Col source="platform" label="平台" />
      </DataTable>
    </List>
  </>;
}

export const WorkspaceShow = () => <Show title="工作区详情" actions={false} queryOptions={{ refetchInterval: 5000 }}><WorkspaceDetails /></Show>;

function WorkspaceDetails() {
  const workspace = useRecordContext<Workspace>();
  return workspace ? <WorkspaceContent key={workspace.id} workspace={workspace} /> : null;
}

function WorkspaceContent({ workspace }: { workspace: Workspace }) {
  const { data: identity } = useGetIdentity();
  const { data: members } = useGetList<Member>(`workspaces/${workspace.id}/members`, { pagination: { page: 1, perPage: 1000 }, sort: { field: "email", order: "ASC" } });
  const canManage = identity?.role === "admin" || members?.some((member) => member.userId === identity?.id && member.role === "owner");
  return <div className="space-y-6 pb-6 min-w-0">
    <Card><CardHeader><CardTitle>{workspace.name}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
      <Badge variant={workspace.agentConnected ? "default" : "secondary"}>{workspace.agentConnected ? "Agent 在线" : "Agent 离线"}</Badge>
      <p className="text-muted-foreground break-all">{workspace.workspacePath || "等待 VS Code Agent 连接"}</p>
    </CardContent></Card>
    <TokenPanel workspaceId={workspace.id} canManage={!!canManage} />
    <List resource={`workspaces/${workspace.id}/members`} title="成员" actions={false} exporter={false} disableBreadcrumb disableSyncWithLocation storeKey={false}>
      <DataTable<Member> rowClick={false} bulkActionButtons={false}>
        <DataTable.Col source="email" label="邮箱" />
        <DataTable.Col source="role" label="角色" render={(record) => workspaceRoles[record.role as Member["role"]]} />
      </DataTable>
    </List>
  </div>;
}

function TokenPanel({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pending, setPending] = useState(false);
  const notify = useNotify();
  const refresh = useRefresh();
  const createToken = async () => {
    setPending(true); setConnection(null);
    try {
      // 凭据只保留在当前页面内存，离开页面或切换工作区即清除。
      const result = await request<{ id: string; token: string }>(`/api/workspaces/${workspaceId}/tokens`, { method: "POST", body: JSON.stringify({}) });
      setConnection({ ...result, workspaceId }); refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "创建失败", { type: "error" }); }
    finally { setPending(false); }
  };
  const revokeToken = async (id: string) => {
    setPending(true);
    try { await request(`/api/workspaces/${workspaceId}/tokens/${id}`, { method: "DELETE" }); if (connection?.id === id) setConnection(null); refresh(); notify("Token 已撤销"); }
    catch (error) { notify(error instanceof Error ? error.message : "撤销失败", { type: "error" }); }
    finally { setPending(false); }
  };
  return <section className="space-y-4">
    {canManage && <div className="space-y-2"><Button disabled={pending} onClick={() => void createToken()}>生成连接信息</Button><p className="text-sm text-muted-foreground">生成后可复制 MCP 链接、一键导入 VS Code。已有连接可直接在 VS Code 中复制 MCP 链接。</p></div>}
    {connection && <ConnectionLinks connection={connection} onHide={() => setConnection(null)} />}
    <List resource={`workspaces/${workspaceId}/tokens`} title="工作区 Token" actions={false} exporter={false} disableBreadcrumb disableSyncWithLocation storeKey={false} queryOptions={{ refetchInterval: 5000 }}>
      <DataTable<Token> rowClick={false} bulkActionButtons={false}>
        <DataTable.Col source="prefix" label="前缀" />
        <DataTable.Col source="createdAt" label="创建时间"><DateField source="createdAt" showTime locales="zh-CN" /></DataTable.Col>
        <DataTable.Col source="revokedAt" label="状态" render={(record) => record.revokedAt ? "已撤销" : "有效"} />
        {canManage && <DataTable.Col label="操作" render={(record) => !record.revokedAt && <Button variant="outline" size="sm" disabled={pending} onClick={() => void revokeToken(String(record.id))}>撤销</Button>} />}
      </DataTable>
    </List>
  </section>;
}

export const UserList = () => <List title="用户管理" exporter={false}>
  <DataTable<User> rowClick="edit" bulkActionButtons={false}>
    <DataTable.Col source="email" label="邮箱" />
    <DataTable.Col source="role" label="全局角色" render={(record) => record.role === "admin" ? "管理员" : "普通用户"} />
  </DataTable>
</List>;
export const UserEdit = () => <Edit title="修改用户角色" actions={false} mutationMode="pessimistic"><SimpleForm><TextInput source="email" label="邮箱" disabled /><SelectInput source="role" label="全局角色" choices={roles} validate={required()} /></SimpleForm></Edit>;
export const CallList = () => <List title="调用记录" sort={{ field: "createdAt", order: "DESC" }} exporter={false} queryOptions={{ refetchInterval: 5000 }}>
  <DataTable rowClick="show" bulkActionButtons={false}>
    <DataTable.Col source="tool" label="工具" />
    <DataTable.Col source="workspace" label="工作区"><ReferenceField source="workspace" reference="workspaces" link="show" empty="—" /></DataTable.Col>
    <DataTable.Col source="status" label="状态" />
    <DataTable.Col source="durationMs" label="耗时（ms）" />
    <DataTable.Col source="createdAt" label="时间"><DateField source="createdAt" showTime locales="zh-CN" /></DataTable.Col>
    <DataTable.Col source="error" label="错误" />
    <DataTable.Col label="操作"><ShowButton label="查看详情" /></DataTable.Col>
  </DataTable>
</List>;
