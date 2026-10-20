# Use a chatflow as an Orchestrate toolkit

Give your IBM watsonx Orchestrate agents a tool you build on the Cuttlely canvas. A published chatflow or agentflow answers as a [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) MCP server at `/api/v1/mcp/<flow id>`, and Orchestrate imports that URL as a [remote MCP toolkit](https://developer.watson-orchestrate.ibm.com/tools/toolkits/remote_mcp_toolkits), so a native agent calls your flow as a tool.

Orchestrate can use the same published flow in two ways. As an external agent, the flow runs the whole conversation and, when the flow has a Memory node, keeps memory between turns of the same Orchestrate thread. As an MCP toolkit, the flow is a single tool step a native agent calls, with no memory between calls. Pick the MCP toolkit when the native agent owns the conversation.

This is not the same as registering the flow as a collaborator agent. That path uses an OpenAI-style chat completions URL. IBM documents it under [Connect to external agents](https://developer.watson-orchestrate.ibm.com/agents/connect_agent). This page covers the toolkit (MCP) path only.

The examples use a made-up bakery, Crumb & Co., and a published chatflow named **Bakery hours**.

New to Cuttlely? [Get started in 10 minutes](../../README.md#your-first-10-minutes): three commands and one model key, then publish a chatflow.

## Before you start

You need:

-   A Cuttlely server that Orchestrate can reach over HTTPS. The examples use `$CUTTLELY_URL`.
-   A published chatflow. MCP runs **Live**, not a draft. The flow id is in the canvas address bar. The examples use `$FLOW_ID`.
-   Permission to open **Configuration** on that flow (`chatflows:config` or `agentflows:config`).
-   The watsonx Orchestrate ADK, already pointed at your Orchestrate instance.

Keep the MCP token on the Orchestrate side. Never put it in this repository, a screenshot, or a public toolkit file.

## Turn the flow into an MCP server

1. Open the chatflow canvas and **Publish** if you have not already.
2. Open **Configuration** (the settings control on the canvas).
3. Under **Advanced**, open **MCP Server**.
4. Turn on **Expose as MCP Server**.
5. Set **Tool Name** (letters, numbers, underscores, and hyphens, at most 64 characters), for example `bakery_hours`. This is the MCP tool identifier Orchestrate imports.
6. Set **Description**, for example `Answers Crumb and Co opening hours and holiday closures.` Orchestrate uses this to decide when to call the tool.
7. Select **Save**. Cuttlely shows the **Streamable HTTP Endpoint** and a **Token (Bearer Token)**. Copy both. Cuttlely stores only the token it generated; rotating it invalidates the previous one.

The endpoint is:

```text
$CUTTLELY_URL/api/v1/mcp/$FLOW_ID
```

The token is not an API key. It authenticates MCP JSON-RPC only. A request without `Authorization: Bearer <token>`, or with the wrong token, is `401`.

If the flow has a **Harness** card, bind an API key whose **Harnesses this key may run** list includes that harness, the same rule as the prediction API. The MCP call still sends the MCP token, not that API key. Cuttlely looks up the flow's bound key when the tool runs. A flow with no bound key runs its Harness cards for anyone who has the MCP token.

## What Orchestrate sees

Each flow is one MCP server with one tool.

| Piece       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL         | `$CUTTLELY_URL/api/v1/mcp/$FLOW_ID`                                                                                                                      |
| Transport   | `streamable_http`                                                                                                                                        |
| Auth        | `Authorization: Bearer <MCP token>`                                                                                                                      |
| Server name | `cuttlely-<flow>` from the **flow name**, not the tool name. **Bakery hours** is `cuttlely-bakery-hours`. A name with no usable slug is `cuttlely`.      |
| Tool        | The **Tool Name** you saved (`bakery_hours`)                                                                                                             |
| Tool input  | `question` (string) for a chatflow, or for an agentflow that starts with a question. An agentflow that starts with a form takes a `form` object instead. |

The server name is lowercase `[a-z0-9-]`, at most 64 characters, taken from the flow name (spaces and punctuation become hyphens). [LIVE-TEST]: confirm the name Orchestrate shows after import.

Cuttlely accepts only `Authorization: Bearer <token>`. IBM's ADK lists Bearer Token among Remote MCP auth methods (`--kind bearer`). The same toolkit-import page also says `--app-id` currently accepts only `key_value` connections. [LIVE-TEST]: confirm which connection kind makes Orchestrate send `Authorization: Bearer` as Cuttlely requires. Until that check lands, try `--kind bearer` first; if import refuses it, use `key_value` and record the header names that work.

## Register the toolkit

Fill in the host and flow id in [`samples/orchestrate/bakery-hours.toolkit.yaml`](../../samples/orchestrate/bakery-hours.toolkit.yaml), then import it. Do not put the token in the YAML.

Create a connection named `bakery_hours_mcp` in the draft environment, then import the file. How to add a connection: [Creating connections](https://developer.watson-orchestrate.ibm.com/connections/build_connections).

```bash
orchestrate connections add -a bakery_hours_mcp
orchestrate connections configure -a bakery_hours_mcp --env draft --type team --kind bearer
orchestrate connections set-credentials -a bakery_hours_mcp --env draft --token "$CUTTLELY_MCP_TOKEN"

orchestrate toolkits import -f samples/orchestrate/bakery-hours.toolkit.yaml -a bakery_hours_mcp
```

If import requires `key_value` instead of `bearer`, configure that kind and set credentials as environment entries. Do not put the token in the YAML. [LIVE-TEST]: the `key_value` keys that produce `Authorization: Bearer`.

IBM currently documents that `orchestrate toolkits add --app-id` accepts only `key_value` connections. [LIVE-TEST]: whether that add works with the `bearer` connection above, or needs `key_value`. Until that check lands, prefer `toolkits import` with the YAML. A one-command add, still with `streamable_http`, looks like this:

```bash
orchestrate toolkits add \
  --kind mcp \
  --name bakery_hours \
  --description "Crumb and Co opening hours" \
  --url "$CUTTLELY_URL/api/v1/mcp/$FLOW_ID" \
  --transport streamable_http \
  --tools "*" \
  --app-id bakery_hours_mcp
```

IBM's import talks to the MCP server, waits up to 30 seconds for `tools/list`, and checks tool schemas. It does not run the tool. After import, add `bakery_hours` to a native agent.

A curl check against Cuttlely, with no Orchestrate involved:

```bash
curl -s "$CUTTLELY_URL/api/v1/mcp/$FLOW_ID" \
  -H "Authorization: Bearer $CUTTLELY_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}'
```

The `initialize` result includes `serverInfo.name`. For **Bakery hours** that is expected to be `cuttlely-bakery-hours`. [LIVE-TEST]: confirm the name Orchestrate displays matches that value.

## HTTP methods

The MCP router is stateless. It does not keep a session id.

| Method    | What Cuttlely does                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST`    | JSON-RPC: `initialize`, `tools/list`, `tools/call`, and the other Streamable HTTP messages. Needs the Bearer token. The body is capped at 1 MB, whatever **Largest upload** (`CUTTLELY_FILE_SIZE_LIMIT`) is set to. Over 1 MB is 413.                                                |
| `DELETE`  | **405** from the app, with `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Session termination is not supported in stateless mode."},"id":null}`. This is not an SDK fallback. Orchestrate can ignore it.                                                                        |
| `OPTIONS` | CORS preflight. `Access-Control-Allow-Methods` is `POST, DELETE, OPTIONS`. GET is excluded. `MCP_CORS_ORIGINS` sets which browser origins may call; clients that send no `Origin`, such as desktop and server clients, pass.                                                         |
| `GET`     | Registered. **405** from the app, with `Allow: POST, DELETE, OPTIONS` and `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method Not Allowed. This MCP endpoint does not offer server-initiated streams."},"id":null}`. This server does not offer server-initiated MCP streams. |

A browser CORS client needs `MCP_CORS_ORIGINS` (or **Sites that may call the MCP endpoint** in Server settings). Orchestrate's ADK is a server client and sends no `Origin`.

The flow's **Rate Limit** in **Configuration** still applies to MCP `POST`.

## When a tool call fails

`tools/call` runs the published flow the same way the prediction API does. If that run throws, the MCP tool result is not a JSON-RPC transport error. The tool returns:

```text
An error occurred while executing the tool. Please try again later.
```

with `isError: true`. The server log has the real message. Orchestrate should treat that as a failed tool call, not as a dropped connection.

A missing flow, a disabled MCP server, or a wrong token is a JSON-RPC error on the POST (`404` / `401`), before the tool runs.

## Sample files

[`samples/orchestrate/`](../../samples/orchestrate/) has the ADK toolkit YAML for **Bakery hours** and a short README. The YAML uses made-up hosts and ids. Copy it, fill in your URL and flow id, and keep the token in the connection, not in the file.

## Next steps

-   [Get started in 10 minutes](../../README.md#your-first-10-minutes)
-   IBM's [Importing remote MCP toolkits](https://developer.watson-orchestrate.ibm.com/tools/toolkits/remote_mcp_toolkits)
-   [Share and embed a chat](./share-and-embed.md)
-   [Harnesses](./harnesses.md), noting that you bind a key that lists the harness
-   [Use the API in your own web app](../api.md)
-   [Star on GitHub](https://github.com/cuttlely/cuttlely) if this page saved you time
