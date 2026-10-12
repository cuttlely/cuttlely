# Usage API

Daily input and output token totals for one workspace. How a single run shows its tokens is in [Where a run shows the tokens](../how-to/context-and-tokens.md#where-a-run-shows-the-tokens). This route is the total over time.

`GET /api/v1/stats/usage`

A signed-in session can call it, and so can an API key. The totals are only for the caller's active workspace. Another workspace's rows are not included.

A finished chatflow, agentflow, Multi Agents canvas, or Sequential Agents canvas adds its tokens under that flow's id. Those canvases count the model calls the graph already reports. A harness run started from the harness API adds its tokens under the harness name. A chatflow whose only node is a harness stores the team's route, specialist, and handoff tokens on the chatflow. A chatflow whose Tool Agent calls the harness tool stores those same tokens on the chatflow, because the tool's answer text does not carry them. The harness name does not get a second copy. An Agent step that calls tools stores the sum of each model call's input tokens and output tokens. A run that did not report token counts adds nothing. A failed write does not change the run's answer.

The caller needs `chatflows:view` or `agentflows:view`. Without either, the route returns 403. The workspace owner is allowed. The same permission gates `GET /api/v1/stats/:id`.

A publish check counts toward usage. Replaying a question before you publish spends tokens, and those tokens are added to that flow's daily total.

The route returns token counts. It does not return prices.

## Range

| Query       | Meaning                                                                               |
| ----------- | ------------------------------------------------------------------------------------- |
| `days`      | `7`, `30`, or `90`. The window ends today (UTC) and includes today. The default is 7. |
| `startDate` | First UTC day, `YYYY-MM-DD`. Required together with `endDate`.                        |
| `endDate`   | Last UTC day, inclusive.                                                              |
| `flowId`    | One chatflow id, agentflow id, or harness name.                                       |
| `model`     | One model name, as the run recorded it.                                               |

When both `startDate` and `endDate` are set, they replace `days`. A custom range can cover at most 366 days. Anything else returns 400.

## Response

`days` lists every UTC day in the range, including days with no tokens. `flows` and `models` list only rows that have tokens. Both lists are sorted by id.

```json
{
    "startDate": "2026-10-11",
    "endDate": "2026-10-12",
    "days": [
        { "day": "2026-10-11", "inputTokens": 105, "outputTokens": 35 },
        { "day": "2026-10-12", "inputTokens": 116, "outputTokens": 39 }
    ],
    "flows": [
        { "flowId": "flow-bakery", "inputTokens": 210, "outputTokens": 70 },
        { "flowId": "flow-orders", "inputTokens": 11, "outputTokens": 4 }
    ],
    "models": [
        { "model": "claude", "inputTokens": 60, "outputTokens": 18 },
        { "model": "gpt-4.1-mini", "inputTokens": 161, "outputTokens": 56 }
    ],
    "totals": { "inputTokens": 221, "outputTokens": 74 }
}
```

```bash
curl -s "$CUTTLELY_URL/api/v1/stats/usage?days=30&flowId=$FLOW_ID" \
  -H "Authorization: Bearer $CUTTLELY_API_KEY"
```

`GET /api/v1/stats/:id` is unchanged. It still returns message, session, and feedback counts for one chatflow.
