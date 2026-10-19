# Call a chatflow from IBM watsonx Orchestrate

A published Cuttlely chatflow can answer as a collaborator for an IBM watsonx Orchestrate native agent. Bind an API key to the chatflow, then register an external agent whose `api_url` points at that flow. This page covers IBM's `external_chat` contract (OpenAI-style chat completions) and IBM's A2A 0.3.0 contract. The Harbor bakery hours demo, including the sample YAML, is in [Record the Orchestrate demo](./orchestrate-demo.md).

Copy each sample YAML, fill in the host, flow id and API key, and import **that filled-in copy**. Do not import the files from this repository: they hold placeholders, not a working agent.

IBM's agent YAML shape is in [Connect to an external agent](https://developer.watson-orchestrate.ibm.com/agents/connect_agent).

## Before you start

You need:

-   A Cuttlely server that Orchestrate can reach (`$CUTTLELY_URL`). A local server needs a public HTTPS URL in front of it; the demo runbook starts `scripts/orchestrate-live-proxy.mjs` so the tunnel only forwards Orchestrate routes.
-   A chatflow that already answers in the canvas chat. Its id is in the address bar and in **API Endpoint** (`</>`).
-   An API key bound to that chatflow. A flow with no bound key is refused (`403` `keyless_flow`). `deployed` is not the gate; the bound key is, the same as [`POST /api/v1/prediction/:id`](../api.md#ask-a-chatflow).

The demo flow uses a Grok chat model (`chatXAI`, default `grok-4.7`) with an xAI credential. Add that credential in **Credentials** off-screen, then pick it on the Grok card. Do not put a key in the imported JSON, in the YAML, or in a screenshot.

## Register an `external_chat` agent

In the Orchestrate UI, register the external agent under **AI Gateway** → **Agent directory** → **Add agent**. Set its `api_url` to `$CUTTLELY_URL/api/v1/orchestrate/<flow id>`. IBM may call that URL or append `/chat/completions`; both paths run the same handler.

People do not chat with that external agent directly. They chat with a **native** Orchestrate agent that has the Cuttlely agent added as a collaborator. Orchestrate then calls the Cuttlely flow through `chat_with_collaborator`.

```yaml
spec_version: v1
kind: external
name: harbor_bakery_hours
title: Harbor bakery hours
nickname: harbor_bakery_hours
provider: external_chat
description: Cuttlely chatflow Harbor bakery hours
tags:
    - cuttlely
api_url: 'https://YOUR_HOST/api/v1/orchestrate/YOUR_FLOW_ID'
auth_scheme: API_KEY
auth_config:
    token: '<API_KEY>'
chat_params:
    stream: true
config:
    hidden: false
    enable_cot: false
```

The sample is [`samples/orchestrate/external-chat.agent.yaml`](../../samples/orchestrate/external-chat.agent.yaml). Copy it, replace `YOUR_HOST`, `YOUR_FLOW_ID` and `<API_KEY>`, and import the copy.

**Auth.** Send the flow's API key as `Authorization: Bearer <key>` (`auth_scheme: BEARER_TOKEN`) or `X-API-Key: <key>` (`auth_scheme: API_KEY`). If both headers are present they must match (`400` `credentials_conflict`). A missing or wrong key is `401` `unauthorized`. IBM `auth_scheme: NONE` does not work in production.

**Body.** OpenAI-style chat completions. `messages` is required. `"stream": true` writes `text/event-stream` frames named `thread.message.delta`. Anything else returns a `chat.completion` object. This route does not accept `overrideConfig`, uploads, or a client session token. Chain-of-thought frames (`enable_cot`) are not sent; leave `enable_cot` off.

**Threads.** Optional `X-IBM-THREAD-ID` continues one conversation on that flow and key. Send it only on the Orchestrate routes (`/api/v1/orchestrate/...`). Omit it and each call is a new chat; earlier `user` and `assistant` turns in `messages` become history. A second stream on the same thread while the first is still open is `409` `thread_busy`. In queue mode with more than one API replica, that busy check is per replica.

A flow that uses Buffer Memory continues from stored turns when `X-IBM-THREAD-ID` is sent. A flow with no memory node answers from the `messages` history only if that flow reads it.

The API reference, including a curl example, is [Call a chatflow from Orchestrate](../api.md#call-a-chatflow-from-orchestrate).

## Register an A2A 0.3.0 agent

IBM also connects an external agent over A2A 0.3.0 (`provider: external_chat/A2A/0.3.0`). The URL you give IBM is the JSON-RPC URL, which is also the agent card's `url`:

`$CUTTLELY_URL/api/v1/a2a/<flow id>`

Do not point `api_url` at the card path. The card is:

`GET /api/v1/a2a/<flow id>/.well-known/agent-card.json`

Continuity uses A2A `contextId`, not `X-IBM-THREAD-ID`. Do not send `X-IBM-THREAD-ID` on A2A routes.

Set `A2A_PUBLIC_BASE_URL` to the public origin (scheme and host, no path, no trailing slash) so the card's `url` matches the address Orchestrate calls. The live demo sets it to the tunnel origin.

The card `name` is the flow name. The card `description` and each skill description are the fixed sentence `Cuttlely chatflow <flow name>`. For the Harbor bakery demo that is `Cuttlely chatflow Harbor bakery hours`.

Use these names in Orchestrate:

| Role                     | Name                  |
| ------------------------ | --------------------- |
| Connection (the API key) | `cuttlely_a2a_key`    |
| External A2A agent       | `cuttlely_a2a_test`   |
| Native router            | `cuttlely_a2a_router` |

Discover the card (IBM's `-e` custom endpoint flag) with the connection that holds the flow key:

```bash
orchestrate agents discover -u https://YOUR_HOST -e /api/v1/a2a/YOUR_FLOW_ID/.well-known/agent-card.json -a cuttlely_a2a_key
```

Or import a filled-in copy of [`samples/orchestrate/a2a.agent.yaml`](../../samples/orchestrate/a2a.agent.yaml). The sample pins `api_url` at `https://YOUR_HOST/api/v1/a2a/YOUR_FLOW_ID`, names the agent `cuttlely_a2a_test`, and uses the card description `Cuttlely chatflow Harbor bakery hours`. `chat_params.pushNotifications` is `false`.

A2A JSON-RPC errors use HTTP 200 with a JSON-RPC error object (`-32700` parse, `-32600` invalid request, `-32602` invalid params, `-32603` internal). HTTP refusals (401, 403, 404, 409, 413, 415, 429) keep the same bodies as the Orchestrate routes.

## MCP instead of an external agent

Orchestrate can also call a published chatflow as a remote MCP toolkit. There is no separate per-flow MCP how-to: use the [MCP endpoint](../api.md#mcp-endpoint) on the API page (`POST /api/v1/mcp/<flow id>`, Bearer token). Prefer `external_chat` or A2A when you want IBM's native collaborator chat.

## Troubleshooting

Errors on the Orchestrate routes, before any stream starts, use `{ "error": { "message", "type", "code" } }`.

| Status | code                   | When                                                                                                                  |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 415    | `content_type_invalid` | `Content-Type` is not `application/json`. A `charset` parameter is fine.                                              |
| 400    | `flow_id_invalid`      | The flow id is not a UUID.                                                                                            |
| 400    | `messages_invalid`     | The body is not an object, or `messages` is missing, empty, over 200, has a bad role or content, or has no user turn. |
| 400    | `thread_id_invalid`    | `X-IBM-THREAD-ID` fails the pattern or is repeated. Orchestrate routes only; A2A uses `contextId`.                    |
| 400    | `credentials_conflict` | `Authorization` and `X-API-Key` differ.                                                                               |
| 401    | `unauthorized`         | Missing, malformed or wrong key, or a lookup error.                                                                   |
| 403    | `keyless_flow`         | The flow has no bound API key. Bind one in **API Endpoint**.                                                          |
| 403    | `origin_not_allowed`   | A browser `Origin` is outside the flow's allowed origins.                                                             |
| 404    | `flow_not_found`       | No chatflow with that id.                                                                                             |
| 409    | `thread_busy`          | Another stream is still open on that thread. In queue mode the check is per replica.                                  |
| 413    |                        | Body over 1 MB.                                                                                                       |
| 429    |                        | The flow's prediction rate limit. Same plain text and headers as `/prediction`.                                       |
| 500    | `internal_error`       | Anything else. The client gets a generic message; the raw error stays in the server log.                              |

One info line per Orchestrate request is logged as `[orchestrate] flow=… path=… thread=… stream=… fields=… status=… ms=…`. `thread` is a short hash, or `none` when IBM sent no `X-IBM-THREAD-ID`. The key, `Authorization`, `X-API-Key`, body text and the raw thread id are never logged.
