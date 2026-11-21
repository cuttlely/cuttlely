# Run a harness in agent mode

Agent mode runs Harness Prime, the chief, on the agent runtime. The chief reads the question, delegates to specialists through the roster's `run_specialist` tool, and writes the final answer. Router mode remains the default: Cuttlely plans and runs the specialist steps itself.

## Call the existing runs API

Publish the harness and give your caller permission to run it. Send `"mode": "agent"` on `POST /api/v1/harnesses/:name/runs`, together with the existing question and optional chat id:

```http
POST /api/v1/harnesses/bakery-help/runs
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

## Read the result

The request waits for the chief's runtime run to finish, using the same completion wait as specialist runs. Cuttlely records one harness run with `mode: "agent"`; the chief's final text is its output, and specialist calls made through `run_specialist` are its steps. The chat and turn context follows those calls, so specialist workspace scope and nested flows use the admitted caller's context.

A specialist call still running when the turn ends is recorded as cancelled. Reuse `chatId` for follow-ups: the chief receives the same recent turns and rolling memory as router mode, within the chief context budget. Failed turns do not enter that conversation history.

## Model binding

Chief and specialist profiles send model completions to Cuttlely's loopback gateway. The gateway binds each profile token to its configured model node and credential, including any configured fallback. The profile holds only its scoped gateway token; it never holds the upstream credential. A request's model string does not select a different upstream model.

The gateway logs the resolved provider node and model id for each completion attempt, including fallback attempts, with the role, harness and profile name. Those log lines contain no keys, tokens or request headers.

## Limits

-   Agent mode is an API option in 1.7.13; there is no mode selector in the app.
-   The chief chooses whether and how often to delegate. Router planning and answer handoff do not run in agent mode.
-   Existing turn limits, runtime availability checks and specialist limits still apply. A timeout or failed runtime run is recorded as a failed harness run.
-   Agent mode makes several model calls per turn (the chief's own calls plus each specialist's), so slower models can reach the existing harness turn budget (`CUTTLELY_HARNESS_TURN_BUDGET_MS`, default 45 seconds); raise it if agent runs time out.
-   Call the Cuttlely runs API. The agent runtime remains private on loopback.
