# m-tunnel Workspace MCP

Connect the current VS Code workspace to an MCP-compatible web client such as ChatGPT or Claude.

## Setup

1. Install the extension.
2. Set `mTunnel.relayUrl` to your m-tunnel Relay URL.
3. Set `mTunnel.token` to a workspace Token created in the m-tunnel admin panel.
4. Open a workspace. The extension connects automatically, or run **m-tunnel: Connect Workspace**.
5. Add the MCP URL `https://your-domain.example/mcp/<WORKSPACE_TOKEN>` to your web client.

The extension exposes `read`, `bash`, `edit`, `write`, and `workspace_info`. Paths are restricted to the current workspace folder; shell commands run with that folder as their working directory.

