# Usage API

Daily input and output token totals for one workspace. How a single run shows its tokens is in [Where a run shows the tokens](../how-to/context-and-tokens.md#where-a-run-shows-the-tokens). This route is the total over time.

`GET /api/v1/stats/usage`

A signed-in session can call it, and so can an API key. The totals are only for the caller's active workspace. Another workspace's rows are not included.

A finished chatflow or agentflow adds its tokens under that flow's id. A harness run started from the harness API adds its tokens under the harness name. A chatflow that calls a harness stores the tokens on the chatflow only. A run that did not report token counts adds nothing. A failed write does not change the run's answer.

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
