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

Cuttlely sent a request and the application did not provide a usable answer. Eligible read requests are retried quietly first, including when a self-hosted gateway returns 502, 503, or 504, so for one of those reads this message appears only after those attempts fail. Sign-in callbacks and other one-time reads are not retried. Canvas saves use the rules below. Publishing remains single-attempt and also uses this message for those gateway responses. Other changes are not retried automatically. Error handlers updated by this change show the same safe connection message for a 502, 503, or 504 instead of showing a gateway page. The connection may have dropped or the request may have timed out.

1. Check that your network connection works.
2. If you have unsaved canvas edits, keep the page open. Canvas changes on an existing saved flow stay on the canvas and are retried quietly for draft and Live saves. If those attempts cannot finish, you see **Your changes aren't saved yet. Choose Retry when the connection is back.** Choose **Retry** after the server recovers. If the browser itself went offline, saving also resumes when the browser reports that it is online again. If someone else saved the draft, the usual review screen opens instead of replacing their work.
3. If Publish gets no answer, Cuttlely checks whether it went through. If it did and Live refreshes, you see the usual **Published** message. If publication went through but the Live canvas cannot refresh, the dialog says **Published, but the canvas could not refresh Live**; close it and reopen the flow when the connection is back. If the check does not prove that the request finished, including when the status still looks unchanged or the check also gets no answer, it says **Publish not confirmed** and disables Publish. Then reopen the flow when the connection is back and check whether its Live version changed before you publish again.
4. For a page-level load failure, reload the page. For a canvas configuration save, keep the canvas open and try that setting again.
5. If the message comes back, ask the person who runs your Cuttlely server to check that it is up.

The create request for a new flow is never repeated automatically. If it gets no answer, that canvas blocks later create attempts because the original request may still have finished. Check your flows in another tab before leaving the canvas. If the flow is absent, leave this canvas and start a new one. If creation answers but its status check fails, Cuttlely repeats only that status check after 300 ms, 1 second, and 3 seconds; it never sends a second create request. If the check still fails, **The flow was created. We are still checking its save status.** appears with **Retry**. The message does not block the canvas, Save remains available, **Retry** repeats only the status check, and the same status check resumes when the browser comes online. On an existing flow, the canvas save is retried, but a follow-up update for its name or starter questions is not. An unanswered inline name stays in the header, keeps the canvas marked as unsaved, and is included by the next canvas **Save**. Starter questions stay pending for the next **Save** too. These updates do not show the canvas retry message. Cuttlely asks you to press **Save** again. Work saved before the message is kept. Reloading the page before a save goes through loses the unsaved edits.
