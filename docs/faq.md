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

## What does "The server could not be reached" mean?

Cuttlely sent a request and got no answer. Read requests are retried quietly first, so this message appears only after those attempts fail. The connection may have dropped, the request may have timed out, or a reverse proxy or cloud gateway in front of a self-hosted install may have blocked it.

1. Check that your network connection works.
2. If you have unsaved canvas edits, keep the page open. Canvas changes on an existing saved flow stay on the canvas and are retried quietly for draft and Live saves. If the connection stays down, you see **Your changes aren't saved yet. We'll keep trying.** Choose **Retry**, or wait for saving to resume when the connection is back. If someone else saved the draft, the usual review screen opens instead of replacing their work.
3. If Publish gets no answer, the message says **Publish not confirmed**. The publish may or may not have gone through. When the connection is back, reopen the flow and check whether its Live version changed before you publish again.
4. Otherwise, reload the page.
5. If the message comes back, ask the person who runs your Cuttlely server to check that it is up.

The create request for a new flow is not retried automatically and does not show the keep-trying message. Press **Save** again after an unanswered create request. If creation answers but the following status check does not, Cuttlely waits and later repeats only that status check. On an existing flow, the canvas save is retried, but a follow-up update for its name or starter questions is not. These updates do not show the keep-trying message. Your edits remain marked as unsaved, and Cuttlely asks you to press **Save** again. Work saved before the message is kept. Reloading the page before a save goes through loses the unsaved edits.
