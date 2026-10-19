# Orchestrate samples

Made-up bakery data only. No tokens, keys, or live hosts.

## Remote MCP toolkit

[`bakery-hours.toolkit.yaml`](./bakery-hours.toolkit.yaml) is an IBM watsonx Orchestrate ADK file for a published Cuttlely chatflow named **Bakery hours**. The how-to is [Use a chatflow as an Orchestrate toolkit](../../docs/how-to/orchestrate-mcp.md). IBM's import steps are in [Importing remote MCP toolkits](https://developer.watson-orchestrate.ibm.com/tools/toolkits/remote_mcp_toolkits). The collaborator-agent path (not this sample) is [Connect to external agents](https://developer.watson-orchestrate.ibm.com/agents/connect_agent).

Copy the YAML. Replace `server_url` with your Cuttlely origin and the flow id from the canvas address bar. Create a connection named `bakery_hours_mcp` and put the MCP Bearer token there. Do not write the token into the YAML or commit a filled-in copy.

The expected MCP `initialize` server name for **Bakery hours** is `cuttlely-bakery-hours`. [LIVE-TEST]: confirm the name Orchestrate displays.

Auth is `Authorization: Bearer` on Cuttlely. [LIVE-TEST]: Bearer Token connection vs `key_value`. GET on `/api/v1/mcp/:id` is also [LIVE-TEST].
