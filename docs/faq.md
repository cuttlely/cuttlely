# Frequently asked questions

## Are stdio MCP servers enabled by default?

No. Local (stdio) MCP servers are off by default. The Custom MCP node connects over SSE/HTTP unless you explicitly set the protocol to stdio.

To enable stdio you must set all of the following on the host:

-   CUSTOM_MCP_PROTOCOL=stdio
-   CUSTOM_MCP_ALLOWED_COMMANDS=<comma-separated list of allowed binaries, for example node or python3>
-   CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS=<comma-separated list of absolute script file paths your stdio servers may execute>
-   (Optional but recommended) CUSTOM_MCP_ALLOWED_ENV_VARS=<comma-separated list of env var names a server may read, for example GITHUB_TOKEN,BRAVE_API_KEY>
-   (Optional) CUSTOM_MCP_SECURITY_CHECK=true (default) to keep validation on

What the server enforces (1.3.2):

-   Stdio is off unless CUSTOM_MCP_PROTOCOL=stdio is set.
-   The command in your MCP config must be allow-listed by CUSTOM_MCP_ALLOWED_COMMANDS or it is refused.
-   If your MCP config has any args, the first argument must match a path listed in CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS, or it is refused. List absolute paths you control. Relative paths are strongly discouraged and only work if you explicitly allow-list that exact relative path.
-   Dangerous flags are blocked; for example, npx -y is refused even if npx is allow-listed.

Short working examples

-   Remote SSE/HTTP (no stdio required):

```json
{
    "url": "https://mcp.example.com/my-server/sse",
    "headers": { "Authorization": "Bearer <token>" }
}
```

-   Local stdio (requires allow-lists):

Environment (host or Compose):

```bash
CUSTOM_MCP_PROTOCOL=stdio
CUSTOM_MCP_ALLOWED_COMMANDS=node
CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS=/opt/mcp/servers/fs-server.js
CUSTOM_MCP_ALLOWED_ENV_VARS=
```

Custom MCP config on the node:

```json
{
    "command": "node",
    "args": ["/opt/mcp/servers/fs-server.js", "/data"]
}
```

Notes

-   Use absolute paths you control in CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS. Relative paths are strongly discouraged and only work if you explicitly allow-list that exact relative path.
-   npx -y and similar auto-install/execute flags are blocked by design.

## Can a macOS or Windows source install save agent profiles?

No. Native macOS and Windows source installs cannot save or compile agent profiles. Run Cuttlely with Docker there.
