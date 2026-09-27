export interface ConnectionConfig { relayUrl: string; token: string }

export function validateConnection(relayUrl: string, token: string): ConnectionConfig {
  const relay = new URL(relayUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname);
  if ((relay.protocol !== "https:" && !(local && relay.protocol === "http:")) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/") {
    throw new Error("服务地址必须是 HTTPS 站点地址（本机调试可使用 HTTP）");
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error("Token 格式无效，请从管理台重新导入");
  return { relayUrl: relay.origin, token };
}

export function parseConnectionUri(value: string): ConnectionConfig {
  const uri = new URL(value);
  if (!["vscode:", "vscode-insiders:"].includes(uri.protocol) || uri.host !== "mxyer.m-tunnel-vscode" || uri.pathname !== "/connect" || uri.hash || uri.username || uri.password) throw new Error("不是有效的 m-tunnel 导入链接");
  if (uri.searchParams.getAll("relay").length !== 1 || uri.searchParams.getAll("token").length !== 1) throw new Error("连接参数缺失或重复");
  return validateConnection(uri.searchParams.get("relay") ?? "", uri.searchParams.get("token") ?? "");
}

export function mcpUrl(config: ConnectionConfig): string {
  return `${config.relayUrl}/mcp/${encodeURIComponent(config.token)}`;
}
