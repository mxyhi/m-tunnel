export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ToolName = "read" | "bash" | "edit" | "write";
export interface ReadInput { path: string; offset?: number; limit?: number }
// Agent 协议中的 timeout 使用毫秒；公开 MCP 的秒数由 Relay 换算。
export interface BashInput { command: string; timeout?: number }
export interface EditInput { path: string; edits: Array<{ oldText: string; newText: string }> }
export interface WriteInput { path: string; content: string }
export type ToolInput = ReadInput | BashInput | EditInput | WriteInput;
export interface ToolCallMessage { type: "tool_call"; id: string; tool: ToolName; arguments: ToolInput }
export interface ToolResultMessage { type: "tool_result"; id: string; ok: boolean; content: string; details?: { exitCode?: number; stderr?: string } }
export interface AgentHelloMessage { type: "agent_hello"; workspace: string; platform: string; name?: string; bindingKey?: string }
export type AgentMessage = ToolResultMessage | AgentHelloMessage;
export interface AgentReadyMessage { type: "agent_ready"; workspaceId: string; name: string }
