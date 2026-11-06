# Dash Flows (skunkworks MVP)

Dash Flows turns a harness's tested PostgreSQL queries into a draggable dashboard. It calls the existing PostgreSQL MCP pinned-tool execution path, stores complete typed rows in a table, and renders later reads without a model or database-source call. It does not parse numbers from an agent answer.

## Build a dashboard

1. Enable [pinned queries](./pinned-queries.md), connect the harness's PostgreSQL MCP node, test its queries and publish the harness. Pins with secure parameters are excluded from the MVP.
2. Open **Dash Flows**. Choose the harness and give the dashboard a title.
3. Drag **Key metric**, **Bar chart**, **Trend line**, **Composition**, or **Evidence table** onto the canvas. Clicking a card type also works.
4. Select a tested query. Enter its exact parameter object and an explicit business scope/period label. Choose a numeric field for a metric or chart, and a label field for a chart. A metric needs one row; calculate aggregates in the tested source.
5. **Save draft**, then **Refresh**. Missing credentials, changed stamps, invalid parameters, query failures, changed columns, partial pages and potentially capped results refuse the refresh. A failed refresh retains the last good snapshot for that saved definition.
6. Hover a bar to see its exact source label/value; click it to inspect that row. **Inspect evidence** shows the original returned rows, exact parameters, scope label, harness, pin identity, version, statement fingerprint and refresh time.

The fingerprint identifies the executed statement, not the business meaning of a metric. Scope labels and parameter selection are author supplied. A tested pin does not independently establish the correct account, date range, population, denominator or currency. Decimal strings retain their original bytes. Null values are unavailable, not zero. The UI does not sum rows or invent derived measures.

## Refresh and publish

Choose **On demand**, **Every hour**, or **Every day** under **Refresh draft**. Save and run the first refresh to arm the interval. The server polls once a minute, rechecks the saving author's current team update permission, and claims a durable lease before execution. Missed times produce one refresh, not a backlog. A restart retains the schedule and snapshots. Each dashboard is refreshed atomically; a partial failure never replaces some cards while leaving others from another run.

**Publish & share** releases the saved, refreshed snapshot and copies a `/dashboards/:id` team link. A viewer must sign in, select the dashboard's team and have `chatflows:view`. Builders need `chatflows:update` for drafts, source discovery, refresh and publication. API keys and anonymous visitors cannot access dashboard routes. No public dashboard option is implemented.

Published definitions and data are frozen together. Draft edits and scheduled draft refreshes do not change a published view: explicitly publish again to release new data. **Unpublish** revokes subsequent shared reads. A person who already loaded data can still retain their copy. Published reads execute neither queries nor models. Phone-sized published views stack the cards instead of requiring canvas navigation.

## Storage and operating limits

`dashflows.sqlite` lives under the harness data directory (`CUTTLELY_DATA_DIR`, otherwise the repository's `.cuttlely` directory). The `dash_flow` table stores workspace, author, revision, definition, last-good typed snapshot, frozen publication, interval due time and refresh lease. SQLite WAL and compare-and-update claims coordinate processes on one shared local volume. Back up this database alongside the harness data. Distributed replicas with separate data volumes are unsupported.

Widget **Filters** opens the source parameter form: date/date-range inputs appear only when the tested source declares them; enumerated periods, numeric limits and other filters keep their source types and bounds. Applying a filter clears the displayed stale snapshot and requires Save/Refresh before republishing. Charts can keep source order or sort by value; tables sort on their headers. These display sorts preserve the original evidence-row identity. A trend follows returned observation order; a composition is for disjoint nonnegative categories, never overlapping risk drivers. Published viewers can sort stored tables, but changing source parameters remains a builder action.

The first slice allows 12 cards, 1,000 complete rows and 512 KB of row JSON per card. A query whose returned row count reaches its literal LIMIT is refused because completeness is uncertain. The explicit exception is a single-row aggregate envelope with a configured source field whose value is boolean `true` for completeness. A bounded nested row-array path can select chart rows from that envelope; the original envelope remains available in evidence. A transport truncation or cursor is still refused. Narrow its scope or aggregate at the source. Schedule times are fixed intervals after completion, not calendar-aware cron. Parameters stay fixed; a moving reporting period must be defined explicitly in the tested query. Credentials stay in the harness; neither SQL nor credentials are copied into a dashboard.

This MVP does not include dashboard deletion, card resizing, arbitrary computed fields, model-generated dashboards, public embeds, a full version-history UI, or automatic updates to published snapshots. The existing harness cron schedule is unchanged.

## First harness acceptance test

Honeybadger Supreme's actual exported configuration was inspected: seven specialists and 168 eligible pin bindings (including repeated pins across specialists). It supports regional renewal blockers, account health and executive/QBR reports, current account ACV, renewal exposure, realized churn context, pipeline outlook, product adoption/utilization, recorded risk patterns, and technical-document retrieval/native document outputs. These measures have different grains and must not be combined indiscriminately. Account identity resolution, current account value, renewal value, forecast risk and realized churn remain distinct.

With `honeybadger-supreme` selected, **Use Supreme risk view** binds three cohort cards to its existing `pq_quarter_account_risk_patterns` source: distinct accounts at risk, renewal opportunities in scope and nine recorded driver-text categories. The query covers the current UTC quarter's open, non-omitted renewals with High, Moderate or Slight Risk and valid active account identities. It aggregates the full eligible cohort before returning one envelope. Categories overlap and cannot be added; prevalence is not a churn probability or causal finding. Missing feedback evidence does not prove absent customer engagement.

The aggregate contract uses `risk_pattern_payload.complete` and `risk_pattern_payload.patterns`; the metrics use `total_risk_accounts` and `total_risk_opportunities`. The preset takes the statement hash from the selected harness catalog. Cards with the same source and exact parameters share one execution per refresh. A fourth card uses `pq_renewals_at_risk_quarter` for the top ten current-quarter risk-ranked renewal opportunities. This is a disclosed selection, not the whole portfolio: its returned count and total eligible count must agree with the typed selected-row envelope. Full cohort metrics are never computed from this watchlist. The table retains returned account IDs and distinguishes renewal ACV from current account value. This pin supports current/next quarter, next week and rolling next-days scopes; the cohort metric pin stays current-quarter only.

Click a returned account name for its stored evidence. **Run full health report** explicitly starts the existing harness asynchronous-run API using that exact validated 18-character account ID, then polls the recorded result. It does not guess identity from a display name or include arbitrary row text in the question. The server's existing harness run permissions apply; a view-only role sees the snapshot but cannot run a report. Closing the drawer leaves the run in harness history. The report uses current source data and is not written over the dashboard snapshot.

No SQL, customer rows, account identifiers or credentials are embedded in the preset.

A real read-only author query test against the existing Supreme pin succeeded during development (one aggregate envelope; nine pattern categories; complete source flag). The watchlist author query test also succeeded (ten selected records with account IDs and consistent count metadata). Both real query results passed local materialization and durable storage for all four cards using two executions. One full-health request for an exact returned account ID succeeded through the live asynchronous harness API in approximately 33 seconds. The exported configuration and business data stayed outside the repository. This validates the real query-result contract, not a deployed dashboard: Dash Flow endpoints were not deployed to that server, and production Dash Flow scheduling/sharing were not exercised. Synthetic tests cover storage, authorization, UI and publication behavior separately.

Local coverage:

```bash
node --test packages/harness/dashflows.test.mjs
pnpm --filter @cuttlely/server test --runInBand src/routes/dashflows/index.test.ts
pnpm --filter @cuttlely/ui test --runInBand src/views/dashflows/index.test.js
node scripts/live-e2e/dashflows-ui.mjs # UI dev server required; synthetic fixtures only
pnpm verify
```

The committed fixtures are synthetic contract tests; the separate live query acceptance described above used private source data. Source pin stamps are checked by the existing PostgreSQL MCP implementation at execution; the dashboard additionally checks the returned pin receipt, complete-result flags and display field shape before materialization.

## Visual showcase

![Supreme renewal-intelligence canvas with synthetic data, two cohort metrics, recorded-signal chart and clickable renewal watchlist](../images/dashflows/supreme-showcase.png)

The screenshot uses synthetic demonstration values and account names. It illustrates the implemented UI, not customer results.
