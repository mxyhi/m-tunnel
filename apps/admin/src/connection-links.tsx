import { useGetOne, useNotify } from "ra-core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Workspace } from "./providers";

export type Connection = { id: string; workspaceId: string; token: string };

export function ConnectionLinks({ connection, onHide }: { connection: Connection; onHide: () => void }) {
  const notify = useNotify();
  const relay = new URL(import.meta.env.VITE_API_URL || window.location.origin).origin;
  const mcp = `${relay}/mcp/${encodeURIComponent(connection.token)}`;
  const vscode = `vscode://mxyer.m-tunnel-vscode/connect?${new URLSearchParams({ relay, token: connection.token })}`;
  const { data: workspace } = useGetOne<Workspace>("workspaces", { id: connection.workspaceId }, { refetchInterval: 3000 });
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); notify(`${label}已复制`); }
    catch { notify("复制失败，请选中链接手动复制", { type: "error" }); }
  };
  return <Card className="mb-6">
    <CardHeader><CardTitle>连接信息</CardTitle><CardDescription>在 VS Code 打开目标文件夹，导入连接后会自动登记工作区。</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <Badge variant={workspace?.agentConnected ? "default" : "secondary"}>{workspace?.agentConnected ? `已连接：${workspace.name}` : "等待 VS Code 连接"}</Badge>
      <div className="flex flex-wrap gap-2">
        <Button render={<a href={vscode} />}>一键导入 VS Code</Button>
        <Button variant="outline" onClick={() => void copy(vscode, "VS Code 导入链接")}>复制 VS Code 导入链接</Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`mcp-${connection.id}`}>MCP 链接</Label>
        <div className="flex gap-2"><Input id={`mcp-${connection.id}`} readOnly value={mcp} onFocus={(event) => event.target.select()} /><Button variant="outline" onClick={() => void copy(mcp, "MCP 链接")}>复制 MCP 链接</Button></div>
        <p className="text-sm text-muted-foreground">将此链接添加到 ChatGPT 等客户端的 MCP 连接器。</p>
      </div>
      <p className="text-sm text-muted-foreground">连接信息仅在本页显示。之后可点击 VS Code 底部的 m-tunnel，随时复制 MCP 链接。</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void copy(connection.token, "Token")}>复制 Token</Button><Button variant="ghost" onClick={onHide}>隐藏连接信息</Button></div>
    </CardContent>
  </Card>;
}
