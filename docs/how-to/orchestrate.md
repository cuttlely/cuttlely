# Call a chatflow from IBM watsonx Orchestrate

Let your IBM watsonx Orchestrate agents hand questions to a flow you built on the Cuttlely canvas: a published chatflow answers as a collaborator for a native agent. Bind an API key to the chatflow, then register an external agent whose `api_url` points at that flow. This page covers IBM's `external_chat` contract (OpenAI-style chat completions) and IBM's A2A 0.3.0 contract. The Larkfield Home orders demo, including the sample YAML, is in [Record the Orchestrate demo](./orchestrate-demo.md).

Copy each sample YAML, fill in the host, flow id and API key, and import **that filled-in copy**. Do not import the files from this repository: they hold placeholders, not a working agent.

IBM's agent YAML shape is in [Connect to an external agent](https://developer.watson-orchestrate.ibm.com/agents/connect_agent).

The made-up `external_chat` setup on this page uses:

| Role in Orchestrate               | Name                  |
| --------------------------------- | --------------------- |
| External Cuttlely agent           | `cuttlely_orders`     |
| Native agent people chat with     | `larkfield_router`    |
| Cuttlely chatflow (imported demo) | Larkfield Home orders |

People chat with `larkfield_router`. That native agent has `cuttlely_orders` as a collaborator. Orchestrate then calls the Cuttlely flow through `chat_with_collaborator`.

## Before you start

You need:

-   A Cuttlely server that Orchestrate can reach (`$CUTTLELY_URL`). A local server needs a public HTTPS URL in front of it; the demo runbook starts `scripts/orchestrate-live-proxy.mjs` so the tunnel only forwards Orchestrate `external_chat` and A2A routes.
-   A chatflow that already answers in the canvas chat. Its id is in the address bar and in **API Endpoint** (`</>`).
-   An API key bound to that chatflow. A flow with no bound key is refused (`403` `keyless_flow`). `deployed` is not the gate; the bound key is, the same as [`POST /api/v1/prediction/:id`](../api.md#ask-a-chatflow).

The demo flow uses a Grok chat model (`chatXAI`, `grok-4.20-0309-non-reasoning`) with an xAI credential. Add that credential in **Credentials** off-screen, then pick it on the Grok card. Do not put a key in the imported JSON, in the YAML, or in a screenshot.

## Register an `external_chat` agent

In the Orchestrate UI, register the external agent under **AI Gateway** → **Agent directory** → **Add agent**. Set its `api_url` to `$CUTTLELY_URL/api/v1/orchestrate/<flow id>`. IBM may call that URL or append `/chat/completions`; both paths run the same handler.

Name the external agent `cuttlely_orders`. Then create the native agent `larkfield_router` and add `cuttlely_orders` as a collaborator. People do not chat with the external agent directly.

```yaml
spec_version: v1
kind: external
name: cuttlely_orders
title: Cuttlely orders
nickname: cuttlely_orders
provider: external_chat
description: Cuttlely chatflow Larkfield Home orders
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

**Threads.** Optional `X-IBM-THREAD-ID` is accepted only on the Orchestrate routes (`/api/v1/orchestrate/...`). Do not send it on A2A routes. When Cuttlely receives that header, it continues one conversation on that flow and key. When the header is omitted, Cuttlely starts a new chat and will use earlier `user` and `assistant` turns in `messages` as history if the flow reads them. A second stream on the same thread while the first is still open is `409` `thread_busy`. In queue mode with more than one API replica, that busy check is per replica.

Whether Orchestrate actually sends `X-IBM-THREAD-ID`, or instead resends earlier turns in `messages`, is an **open item** until the A2A live test. Do not treat either as fact. See [Open items until the A2A live test](#open-items-until-the-a2a-live-test).

The API reference, including a curl example, is [Call a chatflow from Orchestrate](../api.md#call-a-chatflow-from-orchestrate).

## A2A 0.3.0 contract (not yet tested)

**Not yet tested:** this route has contract tests only, no live Orchestrate test. IBM also documents an external agent over A2A 0.3.0 (`provider: external_chat/A2A/0.3.0`). The URL you would give IBM is the JSON-RPC URL, which is also the agent card's `url`:

`$CUTTLELY_URL/api/v1/a2a/<flow id>`

Do not point `api_url` at the card path. The card is:

`GET /api/v1/a2a/<flow id>/.well-known/agent-card.json`

A2A continuity uses A2A `contextId`, not `X-IBM-THREAD-ID`. Do not send `X-IBM-THREAD-ID` on A2A routes.

Set `A2A_PUBLIC_BASE_URL` to the public origin (scheme and host, no path, no trailing slash) so the card's `url` matches the address Orchestrate would call.

## Images and files in Orchestrate answers

Orchestrate shows only the answer text, so images and files the flow stored for the chat (for example a harness diagram or a PDF) are added to the end of the answer as Markdown, on both `/api/v1/orchestrate` and A2A, streaming and non-streaming: an inline Markdown image (an exclamation mark, then `[name](url)`) for PNG, JPEG, GIF and WebP images and `[Download name](url)` for other files. When streaming, the links arrive after the answer as one final delta (A2A: in the last answer chunk).

Each link is an absolute `GET /api/v1/get-upload-file` address on the public origin (`A2A_PUBLIC_BASE_URL`, else the request host). It is signed for that one file, in that chat of that flow, so it opens without the API key; it cannot open another chat's files. Only plain stored file names are linked (spaces and non-ASCII letters are fine): no folders, no server paths. Image links have no `download=true`, and get-upload-file serves PNG, JPEG, GIF and WebP inline so they show in place; other files are downloads. If the server has no signing secret, files are left out rather than sent as links that would need the key. Made-up `attachment:` links are removed from the answer, streamed or not.

`EXTERNAL_FILE_LINK_TTL_SECONDS` sets how long these links work. The default is `3600` (1 hour); values are clamped to `60` .. `86400` (24 hours), and anything that is not a whole number uses the default. Links in the Cuttlely chat itself keep their 15-minute lifetime.

The card `name` is the flow name. The card `description` and each skill description are the fixed sentence `Cuttlely chatflow <flow name>`. For the Larkfield Home orders demo that is `Cuttlely chatflow Larkfield Home orders`.

The sample YAML uses these names:

| Role                     | Name                  |
| ------------------------ | --------------------- |
| Connection (the API key) | `cuttlely_a2a_key`    |
| External A2A agent       | `cuttlely_a2a_test`   |
| Native router            | `cuttlely_a2a_router` |

Copy [`samples/orchestrate/a2a.agent.yaml`](../../samples/orchestrate/a2a.agent.yaml), fill in the host, flow id and key, and import **that copy**. The sample pins `api_url` at `https://YOUR_HOST/api/v1/a2a/YOUR_FLOW_ID`, names the agent `cuttlely_a2a_test`, and uses the card description `Cuttlely chatflow Larkfield Home orders`. `chat_params.pushNotifications` is `false`.

A2A JSON-RPC errors use HTTP 200 with a JSON-RPC error object (`-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal, `-32001` task not found, `-32002` task not cancelable, `-32003` push not supported, `-32004` unsupported, `-32005` content type, `-32007` extended card). HTTP refusals (401, 403, 404, 409, 415, 429) keep the same bodies as the Orchestrate routes. A body over 1 MB is 413 `{ "error": { "message": "Request body too large", "type": "invalid_request_error", "code": "body_too_large" } }`, not the Orchestrate 413 body.

**Open item: A2A registration path.** How you register that agent in Orchestrate (the same **AI Gateway** → **Agent directory** → **Add agent** path, IBM's `orchestrate agents discover` CLI, or another IBM flow) is not confirmed. Do not treat any registration path as fact until the A2A live test. The `external_chat` UI path above is confirmed for `cuttlely_orders` only.

The live proxy in the demo runbook forwards `POST /api/v1/orchestrate/*` and A2A (`GET` card and `POST /api/v1/a2a/<flow id>`).

## MCP instead of an external agent

Use the [MCP endpoint](../api.md#mcp-endpoint) (`POST /api/v1/mcp/<flow id>`, Bearer token). Use `external_chat` when you want IBM's native collaborator chat.

## Open items until the A2A live test

Two items stay open until that test. **Do not state either as fact.**

| Open item                      | What is confirmed                                                                                                                                         | What is not                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **A2A registration path**      | `external_chat` is registered under **AI Gateway** → **Agent directory** → **Add agent**. The A2A sample YAML and card URL are in this repository.        | Which Orchestrate UI or CLI path registers an A2A 0.3.0 agent.                                                                     |
| **Conversation memory source** | Cuttlely accepts optional `X-IBM-THREAD-ID` on Orchestrate routes only, and can also read earlier turns from `messages`. The demo flow has Buffer Memory. | Whether Orchestrate memory in a live chat comes from `X-IBM-THREAD-ID`, or from Orchestrate resending earlier turns in `messages`. |

Fill these in after the A2A live test. Until then the demo runbook records `thread=` (or `thread=none`) without claiming a memory mechanism.

## Troubleshooting

Errors on the Orchestrate routes, before any stream starts, use `{ "error": { "message", "type", "code" } }`, except a body over 1 MB.

| Status | code                   | When                                                                                                                                                        |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 415    | `content_type_invalid` | `Content-Type` is not `application/json`. A `charset` parameter is fine.                                                                                    |
| 400    | `flow_id_invalid`      | The flow id is not a UUID.                                                                                                                                  |
| 400    | `messages_invalid`     | The body is not an object, or `messages` is missing, empty, over 200, has a bad role or content, or has no user turn.                                       |
| 400    | `thread_id_invalid`    | `X-IBM-THREAD-ID` fails the pattern or is repeated. Orchestrate routes only; A2A uses `contextId`.                                                          |
| 400    | `credentials_conflict` | `Authorization` and `X-API-Key` differ.                                                                                                                     |
| 401    | `unauthorized`         | Missing, malformed or wrong key, or a lookup error.                                                                                                         |
| 403    | `keyless_flow`         | The flow has no bound API key. Bind one in **API Endpoint**.                                                                                                |
| 403    | `origin_not_allowed`   | A browser `Origin` is outside the flow's allowed origins.                                                                                                   |
| 404    | `flow_not_found`       | No chatflow with that id.                                                                                                                                   |
| 409    | `thread_busy`          | Another stream is still open on that thread. In queue mode the check is per replica.                                                                        |
| 413    |                        | Body over 1 MB. Global error handler `{ "statusCode": 413, "success": false, "message", "stack" }`. A2A 413 is `{ "error": { "code": "body_too_large" } }`. |
| 429    |                        | The flow's prediction rate limit. Same plain text and headers as `/prediction`.                                                                             |
| 500    | `internal_error`       | Anything else. The client gets a generic message.                                                                                                           |

One info line per Orchestrate request is logged as `[orchestrate] flow=… path=… thread=… stream=… fields=… status=… ms=…`. `thread` is a short hash, or `none` when IBM sent no `X-IBM-THREAD-ID`. The key, `Authorization`, `X-API-Key`, body text and the raw thread id are never logged.

## Next steps

-   [Get started in 10 minutes](../../README.md#your-first-10-minutes)
-   [Record the Orchestrate demo](./orchestrate-demo.md)
-   [Use the API in your own web app](../api.md)
-   [Star on GitHub](https://github.com/cuttlely/cuttlely) if this page saved you time
