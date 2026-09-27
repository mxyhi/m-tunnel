import { useRecordContext } from "ra-core";
import { Show } from "@/components/admin/show";
import { DateField } from "@/components/admin/date-field";
import { ReferenceField } from "@/components/admin/reference-field";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ToolCallDetail } from "./providers";

// 详情使用独立查询缓存，避免先把不含正文的列表记录当成完整详情渲染。
export const CallShow = () => <Show title="调用详情" actions={false} queryOptions={{ meta: { detail: true } }}><CallDetails /></Show>;

function formatArguments(value: string | null): string | null {
  if (value === null) return null;
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}

function CallDetails() {
  const call = useRecordContext<ToolCallDetail>();
  if (!call) return null;
  return <div className="min-w-0 space-y-4 pb-6">
    <Card>
      <CardHeader><CardTitle>{call.tool}</CardTitle></CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="text-muted-foreground">工作区</dt><dd><ReferenceField source="workspace" reference="workspaces" link="show" empty="—" /></dd></div>
          <div><dt className="text-muted-foreground">状态</dt><dd><Badge variant={call.status === "error" ? "destructive" : "secondary"}>{call.status === "success" ? "成功" : call.status === "error" ? "失败" : call.status}</Badge></dd></div>
          <div><dt className="text-muted-foreground">耗时</dt><dd>{call.durationMs === null ? "—" : `${call.durationMs} ms`}</dd></div>
          <div><dt className="text-muted-foreground">时间</dt><dd><DateField source="createdAt" showTime locales="zh-CN" /></dd></div>
          <div className="sm:col-span-2"><dt className="text-muted-foreground">调用 ID</dt><dd className="break-all font-mono">{call.id}</dd></div>
        </dl>
      </CardContent>
    </Card>
    <CallContent title="调用参数" value={formatArguments(call.arguments)} missing="此记录未保存调用参数" />
    <CallContent title="返回内容" value={call.result} missing="此记录未保存返回内容" />
    {call.error !== null && <CallContent title="错误信息" value={call.error} missing="无错误信息" />}
  </div>;
}

function CallContent({ title, value, missing }: { title: string; value: string | null; missing: string }) {
  return <Card className="min-w-0">
    <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
    <CardContent>
      {value === null ? <p className="text-sm text-muted-foreground">{missing}</p>
        : value === "" ? <p className="text-sm text-muted-foreground">内容为空</p>
        : <pre aria-label={title} className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-4 text-sm font-mono">{value}</pre>}
    </CardContent>
  </Card>;
}
