import { createRoot } from "react-dom/client";
import { Resource } from "ra-core";
import { QueryClient } from "@tanstack/react-query";
import { Admin } from "@/components/admin/admin";
import { authProvider, dataProvider } from "./providers";
import { WorkspaceList, WorkspaceShow, UserList, UserEdit, CallList } from "./resources";
import { CallShow } from "./call-show";
import "./style.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <Admin title="m-tunnel" dataProvider={dataProvider} authProvider={authProvider} queryClient={queryClient} requireAuth disableTelemetry>
    {(permissions) => <>
      <Resource name="workspaces" options={{ label: "工作区" }} recordRepresentation="name" list={WorkspaceList} show={WorkspaceShow} />
      <Resource name="tool-calls" options={{ label: "调用记录" }} recordRepresentation="tool" list={CallList} show={CallShow} />
      {permissions === "admin" && <Resource name="users" options={{ label: "用户管理" }} recordRepresentation="email" list={UserList} edit={UserEdit} />}
    </>}
  </Admin>,
);
