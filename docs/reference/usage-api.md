# Usage API

Daily input and output token totals for one workspace. How a single run shows its tokens is in [Where a run shows the tokens](../how-to/context-and-tokens.md#where-a-run-shows-the-tokens). This route is the total over time.

`GET /api/v1/stats/usage`

A signed-in session can call it, and so can an API key. The totals are only for the caller's active workspace. Another workspace's rows are not included.

The Usage page at `/usage` shows this route. [Usage over time](../how-to/context-and-tokens.md#usage-over-time) describes the chart, the per-flow table, and the price editor.

A finished chatflow, agentflow, Multi Agents canvas, or Sequential Agents canvas adds its tokens under that flow's id. The canvas test chat on those flows is a finished run, so it counts. Those canvases count the model calls the graph already reports. A harness run started from the harness API adds its tokens under the harness name. A chatflow whose only node is a harness stores the team's route, specialist, and handoff tokens on the chatflow. A chatflow whose Tool Agent calls the harness tool stores those same tokens on the chatflow, because the tool's answer text does not carry them. The harness model calls are not also added by the chatflow counter. The harness name does not get a second copy. An Agent step that calls tools stores the sum of each model call's input tokens and output tokens, including calls from before a tool approval, a structured-output conversion, and a memory summary. A Sequential Agents interrupt writes the waiting action onto the chat message before that action is streamed. The daily total is written when the run finishes. The resume reads that saved action and does not use usage sent on the request. If the resume cannot read the saved action, or the action has no saved id, the resume fails and no partial total is written. An agentflow Agent that calls a harness adds that harness payload to the same flow total as the Agent's own calls. A run that did not report token counts adds nothing. A failed write does not change the run's answer.

The daily total is written only when the run finishes. A run that errors after the model has already answered is not included. A chatflow whose run throws, a harness run that throws, and an agentflow that ends in an error or is cancelled leave those tokens off the total. A knowledge pipeline run is not added.

The caller needs `chatflows:view` or `agentflows:view`. Without either, the route returns 403. The organization owner is allowed without those keys. A missing session returns 401. The same permission gates `GET /api/v1/stats/:id`.

A publish check counts toward usage. Replaying a question before you publish spends tokens, and those tokens are added to that flow's daily total.

The route returns token counts and an estimated cost. The cost is computed when you read the route, from the prices in effect then, not from a price stored with the tokens. Changing a price changes the estimate for days already recorded. Every dollar figure is an estimate. It is not an invoice. Each estimate counts hundred-millionths of a US dollar, and a half unit rounds up. A price of 0 is a known price: those tokens add $0. That is different from `no price`.

The token rows belong to the caller's workspace. A price override belongs to the organization, so every workspace in that organization uses the same prices, and a workspace does not use another organization's override.

## Range

| Query       | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `days`      | `7`, `30`, or `90`. The window ends today (UTC) and includes today. The default is 7.                        |
| `range`     | `7d`, `30d`, or `90d`. The same window as `days`. Cannot be combined with `days`, `startDate`, or `endDate`. |
| `startDate` | First UTC day, `YYYY-MM-DD`. Required together with `endDate`.                                               |
| `endDate`   | Last UTC day, inclusive.                                                                                     |
| `flowId`    | One chatflow id, agentflow id, or harness name.                                                              |
| `model`     | One model name, as the run recorded it.                                                                      |

When both `startDate` and `endDate` are set, they replace `days`. A custom range can cover at most 366 days. `range` is that same preset window and cannot be sent with `days` or with either date. Anything else that is not a valid window returns 400, with one of these messages:

| Request                                                 | 400 message                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `range` together with `days`, `startDate`, or `endDate` | `range cannot be combined with days, startDate, or endDate.`      |
| `range` other than `7d`, `30d`, or `90d`                | `range must be 7d, 30d, or 90d.`                                  |
| Only one of `startDate` and `endDate`                   | `startDate and endDate are both required for a custom range.`     |
| A date that is not `YYYY-MM-DD`                         | `startDate and endDate must be UTC dates in the form YYYY-MM-DD.` |
| `endDate` before `startDate`                            | `endDate must be on or after startDate.`                          |
| More than 366 days                                      | `A custom range can cover at most 366 days.`                      |
| `days` other than `7`, `30`, or `90`                    | `days must be 7, 30, or 90.`                                      |

## Response

`days` lists every UTC day in the range, including days with no tokens. `flows` and `models` list only rows that have tokens. Flows are sorted by id. Models are sorted by name.

Each of those rows, and `totals`, also has `estimatedCostUsd` and `price`. `price` is `known` when every model in that row has a price, `partial` when some do, and `no price` when none do. `estimatedCostUsd` is US dollars. It is `null` when `price` is `no price`, so a missing price is not shown as zero. A `partial` row is only the models that have a price. `totals.unpricedModels` lists the model names that need a price. A day with no tokens has `estimatedCostUsd` of `0` and `price` of `known`.

`estimates` is `true` on every 200 response. The prices are US dollars per million tokens. Defaults come from [the model list](./model-list.md). An organization owner can replace one model's price; see [Model prices](#model-prices). A harness line is stored as the node label, a middle dot, and the catalog id, for example `ChatOpenAI · gpt-4.1-mini`. An override on that full string wins. Otherwise the price is the catalog id after the last `·`. A plain catalog id is unchanged. A string with no catalog match is `no price`. A model name that looks like a secret is stored as `unknown`. Two names that differ only by case stay two rows and are priced apart. A stored model name is cut at 255 characters.

| Field                  | Where                 | Meaning                                                                                  |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `startDate`, `endDate` | top                   | Inclusive UTC days in the window.                                                        |
| `estimates`            | top                   | Always `true`. The dollar figures are estimates.                                         |
| `day`                  | `days[]`              | One UTC day. Days with no tokens are included.                                           |
| `flowId`               | `flows[]`             | Chatflow id, agentflow id, or harness name. Only flows with tokens. Sorted by id.        |
| `model`                | `models[]`            | The name the run recorded. Only models with tokens. Sorted by name.                      |
| `inputTokens`          | each row and `totals` | Input tokens in that bucket.                                                             |
| `outputTokens`         | each row and `totals` | Output tokens in that bucket.                                                            |
| `estimatedCostUsd`     | each row and `totals` | US dollars, or `null` when `price` is `no price`. `0` on a day with no tokens.           |
| `price`                | each row and `totals` | `known`, `partial`, or `no price`. A day with no tokens is `known`.                      |
| `unpricedModels`       | `totals`              | Model names that need a price, sorted. Empty when every model in the window has a price. |

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

| Field       | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `unit`      | Always `usd_per_million_tokens`.                                                   |
| `estimates` | Always `true`.                                                                     |
| `model`     | Catalog id, or the name the owner set an override for.                             |
| `default`   | `{ "input", "output" }` from the model list, or `null` when the list has no price. |
| `override`  | `{ "input", "output" }` the owner set, or `null`.                                  |
| `effective` | The override when one is set, otherwise `default`. `null` when both are missing.   |

`input` and `output` on those objects are US dollars per million tokens.

`PUT /api/v1/model-prices` sets an override for the caller's organization. The body is `{ "model": "gpt-4.1-mini", "input": 0.5, "output": 2 }`. `input` and `output` are required. Each is a number from 0 to 1000000, with at most 8 decimal places. `0` is allowed and prices those tokens at $0. Scientific notation is refused. The response is that model's row after the write, the same fields as one entry in `models`. Setting the same model again replaces the override.

`DELETE /api/v1/model-prices` clears the override. The body is `{ "model": "gpt-4.1-mini" }`, or the same name in the `model` query. The response is that model's row with `override` set back to `null`. Clearing a model that has no override returns that same row. Estimates read after a set or a clear use the new effective price.

A model the list does not know can still be given an override. Until it has one, usage shows `no price` for it. A name longer than 255 characters is refused. A name that looks like a secret is refused here. On a usage write, that same kind of name is stored as `unknown` instead of being refused.

A workspace with no organization returns 400, `This workspace has no organization.` Other 400 messages:

| Body or query                              | 400 message                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Missing `model`                            | `model is required.`                                             |
| `model` longer than 255 characters         | `model is too long.`                                             |
| `model` that looks like a secret           | `model looks like a secret. Use the model name.`                 |
| `input` or `output` in scientific notation | `input must be a plain number of US dollars per million tokens.` |
| `input` or `output` outside 0 to 1000000   | `input must be a number from 0 to 1000000.`                      |
| More than 8 decimal places                 | `input can have at most 8 decimal places.`                       |

The `output` messages use the word `output` in place of `input`.

```bash
curl -s -X PUT "$CUTTLELY_URL/api/v1/model-prices" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1-mini","input":0.5,"output":2}'
```

```bash
curl -s -X DELETE "$CUTTLELY_URL/api/v1/model-prices?model=gpt-4.1-mini"
```

An API key is refused on these three routes, including a key that would be allowed to read usage. Call them from a signed-in organization owner session. A bearer API key on `GET`, `PUT`, or `DELETE /api/v1/model-prices` returns 403. The usage route above still accepts an API key that has `chatflows:view` or `agentflows:view`.
