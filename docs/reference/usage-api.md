# Usage API

Daily input and output token totals for one workspace. How a single run shows its tokens is in [Where a run shows the tokens](../how-to/context-and-tokens.md#where-a-run-shows-the-tokens). This route is the total over time.

`GET /api/v1/stats/usage`

A signed-in session can call it, and so can an API key. The totals are only for the caller's active workspace. Another workspace's rows are not included.

The Usage page at `/usage` shows this route. [Usage over time](../how-to/context-and-tokens.md#usage-over-time) describes the chart, the per-flow table, and the price editor.

A finished chatflow, agentflow, Multi Agents canvas, or Sequential Agents canvas adds its tokens under that flow's id. Those canvases count the model calls the graph already reports. A harness run started from the harness API adds its tokens under the harness name. A chatflow whose only node is a harness stores the team's route, specialist, and handoff tokens on the chatflow. A chatflow whose Tool Agent calls the harness tool stores those same tokens on the chatflow, because the tool's answer text does not carry them. The harness model calls are not also added by the chatflow counter. The harness name does not get a second copy. An Agent step that calls tools stores the sum of each model call's input tokens and output tokens, including calls from before a tool approval, a structured-output conversion, and a memory summary. A Sequential Agents interrupt writes the waiting action onto the chat message before that action is streamed. The daily total is written when the run finishes. The resume reads that saved action and does not use usage sent on the request. If the resume cannot read the saved action, or the action has no saved id, the resume fails and no partial total is written. An agentflow Agent that calls a harness adds that harness payload to the same flow total as the Agent's own calls. A run that did not report token counts adds nothing. A failed write does not change the run's answer.

The caller needs `chatflows:view` or `agentflows:view`. Without either, the route returns 403. The workspace owner is allowed. The same permission gates `GET /api/v1/stats/:id`.

A publish check counts toward usage. Replaying a question before you publish spends tokens, and those tokens are added to that flow's daily total.

The route returns token counts and an estimated cost. The cost is computed when you read the route, from the prices in effect then, not from a price stored with the tokens. Every dollar figure is an estimate. It is not an invoice.

## Range

| Query       | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `days`      | `7`, `30`, or `90`. The window ends today (UTC) and includes today. The default is 7.                        |
| `range`     | `7d`, `30d`, or `90d`. The same window as `days`. Cannot be combined with `days`, `startDate`, or `endDate`. |
| `startDate` | First UTC day, `YYYY-MM-DD`. Required together with `endDate`.                                               |
| `endDate`   | Last UTC day, inclusive.                                                                                     |
| `flowId`    | One chatflow id, agentflow id, or harness name.                                                              |
| `model`     | One model name, as the run recorded it.                                                                      |

When both `startDate` and `endDate` are set, they replace `days`. A custom range can cover at most 366 days. `range` is that same preset window and cannot be sent with `days` or with either date. Any other `range` value returns 400. Anything else that is not a valid window returns 400.

## Response

`days` lists every UTC day in the range, including days with no tokens. `flows` and `models` list only rows that have tokens. Both lists are sorted by id.

Each of those rows, and `totals`, also has `estimatedCostUsd` and `price`. `price` is `known` when every model in that row has a price, `partial` when some do, and `no price` when none do. `estimatedCostUsd` is US dollars. It is `null` when `price` is `no price`, so a missing price is not shown as zero. A `partial` row is only the models that have a price. `totals.unpricedModels` lists the model names that need a price. A day with no tokens has `estimatedCostUsd` of `0` and `price` of `known`.

`estimates` is `true` on every response. The prices are US dollars per million tokens. Defaults come from [the model list](./model-list.md). An organization owner can replace one model's price; see [Model prices](#model-prices). A harness line is stored as the node label, a middle dot, and the catalog id, for example `xAI Grok · grok-4.7`. An override on that full string wins. Otherwise the price is the catalog id after the last `·`. A plain catalog id is unchanged. A string with no catalog match is `no price`.

```json
{
    "startDate": "2026-10-11",
    "endDate": "2026-10-12",
    "estimates": true,
    "days": [
        { "day": "2026-10-11", "inputTokens": 105, "outputTokens": 35, "estimatedCostUsd": 0.0000716, "price": "partial" },
        { "day": "2026-10-12", "inputTokens": 116, "outputTokens": 39, "estimatedCostUsd": 0.0000824, "price": "partial" }
    ],
    "flows": [
        { "flowId": "flow-bakery", "inputTokens": 210, "outputTokens": 70, "estimatedCostUsd": 0.0001432, "price": "partial" },
        { "flowId": "flow-orders", "inputTokens": 11, "outputTokens": 4, "estimatedCostUsd": 0.0000108, "price": "known" }
    ],
    "models": [
        { "model": "claude", "inputTokens": 60, "outputTokens": 18, "estimatedCostUsd": null, "price": "no price" },
        { "model": "gpt-4.1-mini", "inputTokens": 161, "outputTokens": 56, "estimatedCostUsd": 0.000154, "price": "known" }
    ],
    "totals": { "inputTokens": 221, "outputTokens": 74, "estimatedCostUsd": 0.000154, "price": "partial", "unpricedModels": ["claude"] }
}
```

Those dollar figures are an example. They use a price of $0.40 per million input tokens and $1.60 per million output tokens for `gpt-4.1-mini`, and no price for `claude`. 161 input tokens and 56 output tokens are `161 * 0.40 / 1000000 + 56 * 1.60 / 1000000 = 0.000154`.

```bash
curl -s "$CUTTLELY_URL/api/v1/stats/usage?days=30&flowId=$FLOW_ID" \
  -H "Authorization: Bearer $CUTTLELY_API_KEY"
```

`GET /api/v1/stats/:id` is unchanged. It still returns message, session, and feedback counts for one chatflow.

## Model prices

Defaults come from `input_cost` and `output_cost` on each model in the model list. That file stores US dollars per token. These routes use US dollars per million tokens, which is the per-token price multiplied by 1,000,000. A price of $0.40 per million input tokens is `0.4` here and `0.0000004` in the model list.

Only the organization owner can call these routes. Anyone else, including an API key, gets 403. A missing session gets 401.

`GET /api/v1/model-prices` lists each model that has a default or an override. `default` is the model-list price, or `null` when the list has no price. `override` is the price the owner set, or `null`. `effective` is the override when one is set, otherwise the default.

```json
{
    "unit": "usd_per_million_tokens",
    "estimates": true,
    "models": [
        {
            "model": "gpt-4.1-mini",
            "default": { "input": 0.4, "output": 1.6 },
            "override": null,
            "effective": { "input": 0.4, "output": 1.6 }
        }
    ]
}
```

`PUT /api/v1/model-prices` sets an override for the caller's organization. The body is `{ "model": "gpt-4.1-mini", "input": 0.5, "output": 2 }`. `input` and `output` are US dollars per million tokens, from 0 to 1000000, with at most 8 decimal places. The response is that model's row after the write. Setting the same model again replaces the override.

`DELETE /api/v1/model-prices` clears the override. The body is `{ "model": "gpt-4.1-mini" }`, or the same name in the `model` query. The response is that model's row with `override` set back to `null`. Estimates read after a set or a clear use the new effective price.

A model the list does not know can still be given an override. Until it has one, usage shows `no price` for it.

```bash
curl -s "$CUTTLELY_URL/api/v1/model-prices" \
  -H "Authorization: Bearer $CUTTLELY_API_KEY"
```

An API key is refused on these three routes. Call them from a signed-in owner session. The usage route above still accepts an API key that has `chatflows:view` or `agentflows:view`.
