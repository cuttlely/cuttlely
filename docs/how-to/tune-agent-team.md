# Tune and publish an agent team

Start with a working team, then choose how it reads data, produces answers and handles longer runs. This guide connects the agent-team controls to a repeatable check before Publish. Build the first team with [Harnesses](./harnesses.md).

These controls describe current builds of `main`. A tagged image or npm package can be older; check the [changelog](../../CHANGELOG.md) and the fields your server exposes. Trusted outputs and capacity waiting require the Harness Specialist 2.4 inputs. Deploying application code makes a capability available; publishing a harness separately turns its saved configuration Live.

## Organize the teams you already have

Open **Harness · Agent Team**, select **List View** to scan names, categories and model/tool icons, and sort by **Name** or **Last Modified Date**. Use **Card View** when you want the larger cards. Search matches names and categories. Add category tags with **Update Category**. [Open the agent team page](./harnesses.md#open-the-agent-team-page) gives the controls and permissions.

If a teammate needs a different role, use **Admin** > **Users** > **Change role** and select the relevant team. A team role applies to that team, not every team the person belongs to. The page only offers changes your account may make. [Assign a user](./roles-and-permissions.md#assign-a-user) explains owner and permission restrictions.

## Start with tested database access

On a Postgres (MCP) node, choose a dedicated read-only credential, tick the tables and views the specialist needs, then add a [pinned query](./pinned-queries.md). Turn the server flag `CUTTLELY_PINNED_QUERIES` on and restart before using that editor. Each pin has saved SQL, typed parameters and a tested stamp. Test with representative values, including no matches and ambiguous scope. A passing test shows the statement can run; it does not approve its business logic.

Untick **Allow free SQL (query + describe)** if that specialist must use only the saved pins. Adding a pin alone leaves free SQL available. Include the business metric, grain, date basis and status coverage in each pin's purpose so the model can choose correctly. The selection still matters: a saved statement with the wrong join or a model that chooses the wrong period can return an incorrect answer.

Coordinate the node cap, any pin `rowCap`, the literal SQL `LIMIT`, and parameter bounds. To support up to 100 ranked rows, a saved `LIMIT 50` and a ranking parameter with maximum 50 must be changed too, then retested. Counts of all eligible records belong before the display limit. [Coordinate row limits and output](./pinned-queries.md#coordinate-row-limits-and-output) gives the checks.

A physical row cap does not bound the number of records inside one JSON row. Apply the intended limit to packed arrays and export rows before building that envelope, and return the exported count and full eligible count separately. Compute whole-cohort counts and sums before the display cap. If a source is partial, say how many records were exported out of the eligible total; do not label it complete just to satisfy a file renderer. When the requested complete file cannot fit its renderer limit, narrow the scope or use a supported export path. The 100-row setting above is an example, not a change to every server's default.

The query guard still checks every execution and later page. A login with `default_transaction_read_only = on` can validate a query on a primary that grants it `TEMP`: only the temporary-view validation transaction is read-write and it is rolled back; the query transaction remains read-only. A read-only standby cannot perform that validation. The faster batched guard checks do not remove the selection, function or transaction rules. [Dedicated read-only login](./analyst.md#use-a-dedicated-read-only-login) and [selection enforcement](./analyst.md#how-the-selection-is-enforced) cover setup and refusals.

## Choose how the answer is produced

All three shortcuts below are off by default. Choose the one that fits the task instead of enabling every option.

| Setting                             | What it changes                                                                                                                           | Use it when                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Normal specialist and Harness Prime | A specialist does the work, then Prime combines the results.                                                                              | The answer needs several specialists, interpretation or a final combined narrative.                                             |
| **Answer direct**                   | An eligible single specialist's answer skips Prime's final write-up.                                                                      | One specialist already writes the finished answer. Its prose still comes from the model.                                        |
| **Pin first**                       | Exactly one authored rule runs a tested pin and renders its rows before the specialist model.                                             | Your application has a narrow, explicit request form with a stable table response. Other wording falls back to the normal path. |
| **Trusted outputs**                 | A matching tested pin's actual captured result supplies source Markdown or a native PNG/CSV. The protected section skips model rewriting. | Exact source wording, links, series identity or file bytes must be preserved. The model still chooses the query and parameters. |

For **Answer direct**, keep the specialist's own instructions sufficient for the user-facing reply: Prime's persona and Handoff limit do not apply to a direct answer. Eligibility is checked at runtime; unsupported cases keep the normal handoff. [Read the run card](./harnesses.md#read-the-run-card) describes these settings and their limits.

### Try one explicit pin-first form

First create and test `pq_revenue_by_region` from the made-up [demo_sales example](./pinned-queries.md#pq_revenue_by_region). On the specialist, turn **Pin first** on and put this array in **Pin first rules** (`pinFirstRules`):

```json
[
    {
        "id": "regional-revenue-demo",
        "pin": "pq_revenue_by_region",
        "when": ["^regional revenue \\d{4}-\\d{2}-01$"],
        "params": {
            "month": { "source": "extract", "pattern": "(\\d{4}-\\d{2}-01)" }
        },
        "answer": {
            "heading": "Revenue by region",
            "columns": [
                { "key": "region", "header": "Region" },
                { "key": "revenue", "header": "Revenue" }
            ],
            "emptyText": "No revenue rows were returned for that month."
        }
    }
]
```

The explicit command `regional revenue 2026-01-01` extracts a date rather than fixing one year or month in the rule. The saved pin still validates the argument and runs through the same guard. A miss, competing matches or an overlong regex pass uses the normal specialist path. An execution error is not a second attempt at the query.

Keep rules narrow enough to be unambiguous. Do not turn a benchmark's exact questions into the only supported wording. Test ordinary paraphrases, fragments and unclear scope on the normal model path too. The model must ask when scope is materially ambiguous instead of guessing a value that makes a rule fit.

### Preserve a report or a download

Prepare the output in its source query, then bind the actual tested statement hash in **Trusted outputs**. A Markdown contract selects source text fields; the monthly-utilization renderer preserves account/product key/unit series and calendar gaps; a table CSV preserves source headers, order and exact numeric strings. Utilization source tables are limited to 100 rows, and so are CSV source tables unless the CSV contract sets `maxRows`, up to 10,000. Set `escapeFormulas: true` on a CSV contract when people open the file in a spreadsheet app; see [Trusted outputs](../reference/trusted-outputs.md). Contract validation refuses incomplete or mismatched sources rather than inventing missing data.

Use a dedicated export pin when a query should always produce a CSV, and keep the normal ranking pin for text or chart requests. This avoids turning an ordinary table answer into a download just because both tasks use the same business calculation. The complete CSV payload, three contract examples, strict versus verified passthrough policies, limits and empty-result behavior are in [Trusted pinned-query outputs](../reference/trusted-outputs.md).

A mapped Markdown contract replaces that worker's model prose and files. Do not bind a text-only renderer indiscriminately to a general file/chart specialist. Give protected files a dedicated query and the matching PNG or CSV contract, or route the text report to a separate text specialist. A broad assets specialist can use explicit verified passthrough for other successful approved queries; it does not turn a mapped text report into a verified file or recover a missing attachment.

Protected files use the chat's native attachment transport. The runtime validates bytes and the turn deadline, and the chat wrapper waits for file storage before acknowledging a download. A sentence saying a file was created is not a passing file test: download it and inspect its content. When a mapped source is valid but only the model's final completion fails, the runtime can deliver the source output without rerunning the query or model; the trace keeps the original failure and recovery diagnostic.

## Carry intent and record scope between turns

The shared router resolves the request from the conversation and chooses factual presentation or analysis for each step. A factual step preserves a mapped source report without adding optional interpretation. An analytical step retains the specialist's evidence checks and exact source report. Older routing replies that omit this choice keep their existing behavior; a lone specialist still skips routing.

When several specialists share the same wired database-tool node, the planner sees that shared scope and can assign the complete deliverable to one capable owner. A role that can query the data and create the requested artifact does not need an extra query-only predecessor. Distinct sources or materially different work can still require multiple specialists. Shared credentials or similar table names alone do not establish equivalent permissions.

When a displayed table can be matched unambiguously to executed source rows, the runtime saves its record identifiers and order separately from the shortened transcript. The saved selection follows the captures that produced the displayed output. An unused query that returned the same record IDs with extra fields does not break that selection across unrelated turns. The next router and specialist receive those identifiers even after intervening turns or a specialist change. Selections are scoped to the existing harness/chat session, hold at most three tables and 100 records per table within 16 KB, and contain identifiers and labels rather than business measures or SQL. A new claim still requires new source evidence. Ambiguous names, competing entity grains, unsupported rows and oversized selections are not certified; ask for clarification when the reference cannot be resolved.

For opted-in protected interpretation, a rejected quantitative claim can trigger up to two tool-free repairs against the same captured evidence. The second, final repair keeps the material content while dropping unnecessary figures. The repaired text must pass the original validator. Missing or failed evidence is not repaired, queries are not rerun, and cancellation and the turn budget still apply. If repair fails, the verified source report remains available. An unmapped query falls back to a bounded business table rather than dumping nested resolver fields. Equivalent duration abbreviations and written monetary scales use the same quantity, unit and denomination checks.

Keep specialist instructions focused on capabilities, business definitions, source choice and evidence standards. Exercise different follow-ups and entity grains in QA rather than adding a routing rule for each wording.

## Give a longer task the right limits

**Admin** > **Server Settings** > **Agent runtime** > **Limits** > **Agent run time** defaults to 240 seconds and applies to specialist and nested specialist waits. Set 300 for five minutes, or 0 for unlimited, then save and restart. The host/API variable `CUTTLELY_HARNESS_RUN_TIMEOUT_MS` uses milliseconds. [Agent run time](./server-settings.md#agent-run-time) covers the range and restart behavior.

The separate **Turn time limit** bounds the whole turn, including routing and handoff, and can stop work earlier. Model output limits, SQL timeouts and HTTP/tool limits also remain independent. Increasing a handoff character limit does not increase any of those time limits. [How long a turn should take](./harnesses.md#how-long-a-turn-should-take) explains the budget.

For a specialist that should tolerate a short busy period, set **Capacity wait (seconds)** between 1 and 60. Its default 0 is off. It waits only for an explicit agent-runtime concurrency rejection before a run is accepted, within the remaining turn budget and `Retry-After`. It does not rerun an accepted run, model inference or SQL, and it does not retry provider quota errors. Cancellation and the original turn budget still take precedence.

## Call the published team from your app

A HARNESS canvas id works directly on `POST /api/v1/prediction/:id`; a chatflow with a Harness card also works. The public route runs Live. The signed-in canvas chat runs its draft when one exists. Bind the API key to the flow and tick the harness under **Harnesses this key may run** before calling it.

For a follow-up, send the returned `chatId` and its `sessionToken` together. A direct HARNESS canvas stream returns them in `harness.recorded`; a non-streaming response returns them in JSON. A HARNESS canvas refuses uploads with 400. Use a chatflow with a Harness card when the question needs an uploaded file. [API examples](../api.md#agentflows-and-harnesses) include a direct two-turn call, streaming and background runs.

## Check the draft, then publish

1. Check the metric, grain, account resolution, date bounds and status filters against an independent source query. Include ambiguous names, unknown names, zero records and a result above an earlier row limit.
2. Ask the same intent in several ordinary ways, including terse or misspelled questions. Keep largest-value rankings separate from other sort criteria. Do not repair the route just for one phrasing.
3. Download requested files. Compare CSV headers, row order, row count and exact amounts. For a chart, inspect all series and native units, missing-month gaps, partial periods and values above 100% where the source allows them.
4. Use **Compare** or a dataset to measure answer changes, tokens and time on Live and the draft. Keep each run's errors and skipped/unknown grades visible; a new set of easier questions is not the same benchmark. [A/B testing](./ab-testing.md) and [evaluations](./evaluations.md) explain what the built-in checks score.
5. If someone saved the shared draft while you worked, **Review changes** lets you merge non-overlapping changes and choose sides for conflicts. Apply the result to the canvas, check it, then save or publish. [Drafts and Publish](./versioning.md#drafts-and-publish) covers Reload, Save anyway and Publish conflicts.
6. Publish, then repeat a real API/file canary on Live. Save the tested configuration and the observed result so a later change has a reproducible baseline. A deploy and an offline test alone do not prove a model-backed workflow works.

Expand a query chip to inspect `sqlHash`, row previews and query timings. Preview text/values follow the server's trace settings; the audit log deliberately does not store SQL or parameter values. Pinned create/edit/delete/test audit rows identify who made the change, not a second-person approval. [Pinned query traces](./pinned-queries.md#what-the-trace-stores) and [Audit](./pinned-queries.md#audit) explain those records.
