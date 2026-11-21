# Run a harness in agent mode

Agent mode runs Harness Prime, the chief, on the agent runtime. The chief reads the question, delegates to specialists through the roster's `run_specialist` tool, and writes the final answer. Router mode remains the default: Cuttlely plans and runs the specialist steps itself.

## Call the existing runs API

Publish the harness and give your caller permission to run and read it. Send `"mode": "agent"` with the existing question and optional chat id. This API-key example uses `POST /api/v1/harnesses/:name/runs/async` to start a background run:

```http
POST /api/v1/harnesses/bakery-help/runs/async
Authorization: Bearer <your-access-key>
Content-Type: application/json

{
    "mode": "agent",
    "question": "Can I collect a rye loaf on Saturday? Ask the orders specialist to check.",
    "chatId": "bakery-example-001"
}
```

The bakery name, question and chat id are made-up examples. Keep the access key on your application's server. See [Run it from your app with an API key](./harnesses.md#run-it-from-your-app-with-an-api-key) for caller setup and the existing request and response fields.

Omit `mode`, or send `"mode": "router"`, to use router mode. Any other value returns HTTP 400 with a message naming the two accepted values. Agent mode uses the same authentication, workspace and caller checks, Harness run permission, harness access grants, API-key admission and start rate limit as router runs. A refused caller starts no chief call and records no run.

Agent mode accepts text only in 1.7.13. A non-empty `images` field returns HTTP 400 on synchronous, streaming and background runs: `mode "agent" does not accept images yet; use router mode`. The request starts no chief call and records no run. Use router mode for images.

## Read the result

The endpoint determines whether the request waits, for both authorized API-key and signed-in session callers:

-   `POST /api/v1/harnesses/:name/runs` waits for the chief and returns HTTP 200 with `text`, `agents`, `chatId` and the recorded `run` (unless streaming was requested).
-   `POST /api/v1/harnesses/:name/runs/async`, used above, returns HTTP 202 without waiting for the answer:

```json
{
    "runId": "run_7d1c2a4e-5b6f-4c3d-9e8f-0a1b2c3d4e5f",
    "harness": "bakery-help",
    "chatId": "bakery-example-001",
    "status": "queued",
    "statusUrl": "/api/v1/harnesses/bakery-help/runs/run_7d1c2a4e-5b6f-4c3d-9e8f-0a1b2c3d4e5f",
    "resultUrl": "/api/v1/harnesses/bakery-help/runs/run_7d1c2a4e-5b6f-4c3d-9e8f-0a1b2c3d4e5f/result"
}
```

Keep the returned `runId`. From your application's server, read `resultUrl` with the same key every few seconds until `finished` is `true`:

```bash
curl -s "$CUTTLELY_URL/api/v1/harnesses/bakery-help/runs/run_7d1c2a4e-5b6f-4c3d-9e8f-0a1b2c3d4e5f/result" \
  -H "Authorization: Bearer $CUTTLELY_API_KEY"
```

While queued or running, the response has `finished: false` and `result: null`. Once finished, read `status` and `error`; a successful answer is in `result.text`, with specialist steps in `result.agents`. `GET /api/v1/harnesses/:name/runs/:runId` (the returned `statusUrl`) reads the recorded history row and its `trace`, without the full answer. The key can read only runs it started and needs `harness:read`. See [Run a harness in the background](../api.md#run-a-harness-in-the-background) for the response fields and terminal statuses.

Cuttlely records one harness run with `mode: "agent"`; the chief's final text is its output, and specialist calls made through `run_specialist` are its steps. The chat and turn context follows those calls, so specialist workspace scope and nested flows use the admitted caller's context.

A specialist call still running when the turn ends is recorded as cancelled. For synchronous `/runs` requests, including streams, a client disconnect before the response finishes cancels the run; the harness history row and trace both say `cancelled`. If the request is still queued, the worker records that cancellation when it claims the job, without starting the chief or any specialist. This applies to both agent and router mode. Background `/runs/async` runs continue after the client disconnects; there is currently no harness run cancel endpoint. Reuse `chatId` for follow-ups: the chief receives the same recent turns and rolling memory as router mode. Cuttlely reserves the estimated size of the compiled chief instructions and roster before fitting history, memory and the request into the remaining chief text budget. This estimate excludes runtime-added prompts and tool schemas. Failed turns do not enter that conversation history.

## Model binding

Chief and specialist profiles send model completions to Cuttlely's loopback gateway. The gateway binds each profile token to its configured model node and credential, including any configured fallback. The chief profile holds its scoped gateway token, the runtime's API server key and tool credentials, but no model provider keys; it never holds the upstream credential. A request's model string does not select a different upstream model. Harness names with capitals use a lowercase runtime profile id with a short hash of the original name; existing folders are renamed once on upgrade to preserve sessions and memory.

The gateway logs the resolved provider node and model id for each completion attempt, including fallback attempts, with the role, harness and profile name. Those log lines contain no keys, tokens or request headers.

## Limits

-   Agent mode is an API option in 1.7.13; there is no mode selector in the app.
-   The chief chooses whether and how often to delegate. Router planning and answer handoff do not run in agent mode.
-   Existing turn limits, runtime availability checks and specialist limits still apply. A timeout or failed runtime run is recorded as a failed harness run.
-   Agent mode makes several model calls per turn (the chief's own calls plus each specialist's), so slower models can reach the existing harness turn budget (`CUTTLELY_HARNESS_TURN_BUDGET_MS`, default 45 seconds); raise it if agent runs time out.
-   Call the Cuttlely runs API. The agent runtime remains private on loopback.
