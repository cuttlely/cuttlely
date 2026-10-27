# Pinned queries

A pinned query is SQL you write and test on a **PostgreSQL MCP** node. The specialist does not write that statement. It calls a tool that accepts only the parameters you named, and the server runs the saved statement with those values bound.

This guarantees **execution** of the saved statement. It does not guarantee that the statement is the right one for the business. A pin with a wrong join returns that wrong result every time. **Tested is not approved.** A passing test is not a compliance sign-off, and this version has no second-person approval. The audit records who tested the pin and who saved a change. The read-only guard still runs on every call. The tested stamp is a label, not a permission.

Pinned queries are off unless you turn them on. With no pins on the node, free SQL behaves as it does today whether the flag is on or off.

The worked example below uses a made-up `demo_sales` table. It is not a migration and it is not your data.

## Turn the flag on

Set `CUTTLELY_PINNED_QUERIES` to exactly `1` or `true`. Those two values are the only ones that turn it on. Unset, empty, `yes`, `on`, `TRUE`, `false`, `0`, and every other value leave it off.

The key is registered with the analyst server settings, next to `CUTTLELY_ANALYST_TRACE_PREVIEW`. You can also set it in the server environment.

Unsetting the variable, or setting it to anything else, rolls the feature back: pinned tools are not added, a call to one is refused, and the test route refuses the request and does not run a statement. Pins already saved on the node stay saved. The **query** tick is not changed. Set the flag back to `1` or `true` and a pin whose stamp still verifies is offered again.

While the flag is off, a node that has no pins keeps today's free SQL. Turning the flag on does not by itself change that.

## Add a pin

On the **PostgreSQL MCP** node, open **Pinned queries** and choose **Add**.

1. Paste one `SELECT` or `WITH` statement. Use `:name` for each parameter, for example `:month`.
2. Write a one-line purpose. The tool name starts as `pq_` plus a slug taken from that purpose. The `pq_` prefix is fixed and is not editable. The rest is letters, digits, and underscores. The whole name is at most 64 characters.
3. Each `:name` becomes a row in the parameter table. A type Postgres can infer is suggested. If it cannot infer one, you pick it. The suggestion never quietly becomes `text`.
4. Parameters are required unless you say otherwise. Description, default, allowed values, and min/max sit under **Advanced**.
5. **Test & save** runs the statement with the sample values you typed, through the same guard and the same connection the specialist will use. When it passes, the server stores a tested stamp.

A trailing semicolon is refused. The editor can remove it. A statement with no top-level `LIMIT` is refused. The editor can insert `LIMIT 100`. The `LIMIT` count has to be a literal number in the saved SQL. A parameter in `LIMIT` or `OFFSET` is refused, including inside a subquery. `:n` cannot be the page size.

The agent cannot choose the table, the column list, `ORDER BY`, or `LIMIT`. Those stay in the SQL you saved. There is no `IN`-list parameter, no array parameter, and no parameter that names an identifier.

### Parameter types

The type is one of `text`, `int8`, `numeric`, `date`, `timestamp`, `timestamptz`, and `bool`. Each value is bound with a parenthesised cast, `($n::pg_catalog.<type>)`. Anything else is refused. The store compiles both the check text and the run text itself from the saved entry; callers cannot supply compiled SQL.

A `[` or `(` immediately after a parameter is refused, as is an open slice such as `x[:n]`. An array constructor such as `ARRAY[:a, :b]` is accepted when both parameters have valid scalar specs.

`timestamp` and `timestamptz` are different types. A `timestamp` value is not read in the server's local time zone. Values are checked and sent as canonical text, not as a rewritten date.

A value that does not match its type is refused, as is an unknown argument name. Required, default, allowed values, min, and max are enforced. The error names the parameters the tool accepts. The tool never accepts SQL from the model.

These names are refused as parameters: `sql`, `statement`, `query`, `cursor`, `page`. A raw `$1` in the saved SQL is refused. `:name` is the only parameter form.

`?` is not a parameter. JSONB operators such as `tags ? 'seasonal'`, `?|`, and `?&` stay as written. `:name` inside a quoted string, a quoted identifier, a comment, or a dollar quote is not a parameter, and a cast written with `::` is not one either.

Every `:name` in the SQL needs a parameter row, and every parameter row has to appear in the SQL.

### Where it runs

A pin runs only on the PostgreSQL MCP node. The connection is the Postgres URL credential on that node, or `CUTTLELY_POSTGRES_URL` when the node has no credential. The tool takes that connection from the saved node. The test route takes the credential id from the node as it is on the canvas, so a test checks what Save will store. The credential still loads inside your workspace, and a request cannot supply a database URL.

Pins do not run in Auto mode (`CUTTLELY_ANALYST=auto`, isolated tools). With pins configured in that mode the server returns a clear error and registers no `pq_` tools. They are not run on the isolated store, including when that store has no credential and no `CUTTLELY_POSTGRES_URL`, and they are not ignored.

The same read-only guard used by **QUERY** runs at test time and again on every call, including a later page. Validation opens a short read-write transaction only to create a temporary view, which is always rolled back; queries run in a read-only transaction. It checks: one `SELECT` or `WITH`, a literal top-level `LIMIT`, no semicolon, the table and view selection, the function rules, the timeout, and the row cap. The node's row cap and timeout still apply. A pin saved with its own `rowCap` can only lower the node's row cap, at test time and on every call. The test and the agent run read the node's settings the same way: a comma-separated table list is split into names, and a decimal row cap is rounded down to a whole number of rows, at least one. Results carry `pinned: { id, version, statementHash, tool }`. A result that comes back with as many rows as the statement's own `LIMIT` carries `possiblyTruncated`; this does not prove that more rows exist.

The credential, the ticked tables and views, and the allowed functions are the node's. A specialist is offered the pins on the nodes wired to it. If two of those nodes offer the same tool name, harness sync fails with a clear error.

## Tested stamp

**Test & save** asks `POST /api/v1/pinned-queries/:chatflowId/test`. A signed-in editor needs the update permission for that kind of flow (`chatflows:update` or `agentflows:update`). An API key needs the same permission, and the harness canvas check for that flow id. The server loads the flow in the caller's workspace. The node must already be in the open draft (or Live, when there is no draft). The editor sends that node's unsaved credential id, ticked tables and views, allowed functions, row cap, timeout, and pin list in `canvas`; values it does not send come from the draft or Live. The request is refused if `canvas` holds anything else, such as a URL.

The stamp is an HMAC the server computes from the credential encryption key. It covers the workspace, the credential, the statement hash, the parameter spec, the ticked tables and views, the allowed functions, and the columns the test returned. It does not cover the flow id. The server recomputes it when the node starts. If it does not match, the pin is not offered. Hand-editing the flow or pasting a stamp from somewhere else does not make a pin tested. The stamp only decides whether a pin is offered; every call to a pin still runs the full guard (read-only transaction, ticked tables and views, allowed functions, row cap, and timeout).

These make the stamp fail, and the pin has to be tested again:

-   the SQL or the parameter spec changed
-   the credential on the node changed
-   the ticked tables or views, or the allowed functions, changed
-   the flow was imported onto another server
-   the credential encryption key was rotated

A copy of the flow in the same workspace, still using the same credential, keeps the stamp, because the flow id is not part of it. A copy in another workspace does not. An export includes the SQL. It does not include the database credential.

A passing test records who ran it. That person tested the statement. They did not approve it, and Cuttlely does not record a compliance sign-off.

## Free SQL stays available

Adding pins does not turn off free SQL. The **query** tick is unchanged. With pins on the node, the dialog labels that tick **Allow free SQL (query + describe)**. The note under it says that with free SQL on, the agent usually picks a pinned query when it fits, and that only pinned-only guarantees it. Leave it ticked and the specialist still has the `query` tool. `describe` comes with `query`. The model will often call a pin when one fits. That is not a guarantee. Only unticking **query** removes free SQL and leaves the pinned tools. That is the pinned-only setting, and it is off unless you untick **query**.

When a free `query` call runs on a node that is offering at least one valid pin, that trace step includes `freeSqlWithPin`, the tool names of those pins. The list is not a match between the SQL text and a pin. It only says the node had offered those pins.

## What the trace stores

Every analyst statement, free SQL and pinned, including a refused call, a failed call, and a later page, has `sqlHash` on the trace step.

`sqlHash` is the full SHA-256 hex digest, 64 characters, of the normalised statement. Normalisation is the one `statementFingerprint` uses: each run of whitespace is collapsed to a single space, trailing semicolons are dropped, and the string is trimmed. The short fingerprint used for a call id is not this field. The digest is not cut down.

A page keeps the original statement's `sqlHash` from the cursor. Paging does not look like a different statement. A refused or failed call still has `sqlHash`.

When `CUTTLELY_ANALYST_TRACE_PREVIEW` is on, the trace includes a capped, redacted SQL preview. `sqlHash` remains available with previews off. Bound values do not become SQL literals in that preview. Secure parameter values must be redacted before capture.

The pin's statement hash identifies the compiled statement and parameter spec. It is distinct from `sqlHash`, which identifies the executed SQL text. Audit rows described below do not contain SQL previews or bound values.

## Column drift

If the column names that come back, or their order, differ from the columns recorded when the pin was tested (a changed column type alone is not compared), the result includes a warning and `columnsChanged`, which say the pin needs a re-test. The editor does not see run results, so it does not mark the pin; re-test the pin in the editor to record the new columns. The editor marks a pin as needing a re-test when its SQL or parameters change after its last test. The call is not blocked. A column the statement itself names that is no longer in the table still makes the query fail, as it does for any other statement.

## Audit

A save that stores a new, changed, or removed pin on Live attempts to write a `pinned_query_change` row. Publish does that, because Publish copies the draft onto Live. Saving a draft does not. A successful **Test & save** attempts to write a `test` row when the test runs, even if the pin is still only on the draft. Audit failures do not block a save or a test result. There is no database migration for the new type.

The row records the flow, the node, the pin name, the version, the user, and the kind of change: `create`, `edit`, `delete`, or `test`. It records a valid 64-character hexadecimal statement hash when the runtime hash helper is available and succeeds. The test helper accepts an already computed hash and omits invalid hashes. It can also name the credential id and the parameter names. It does not record the SQL text, parameter values, defaults, allowed values, or sample values. Parameter values, including secure values, are never copied into audit rows. Metadata fields are caller-supplied labels and identifiers, not a content scanner: do not put SQL or sensitive values in pin names, versions, parameter names, or identifiers. The row also has the organization and workspace scope, actor and user ids, a timestamp, and a summary containing up to 80 characters of the pin name. Shared audit redaction still applies and drops the detail if its serialized length exceeds 8000 characters. Hash computation and edit comparison can read the saved SQL and parameter spec in memory; those objects are not passed to the audit writer. The same list is on the [audit log](./audit-log.md).

## Example: demo_sales

This table is made up. Create it in the database the node's credential reads, and tick `demo_sales` on the node.

```sql
CREATE TABLE demo_sales (
    id int8 PRIMARY KEY,
    region text NOT NULL,
    month date NOT NULL,
    product text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    units int8 NOT NULL
);

INSERT INTO demo_sales (id, region, month, product, amount, units) VALUES
    (1, 'north', DATE '2026-01-01', 'cedar tea', 120.00, 4),
    (2, 'north', DATE '2026-01-01', 'maple soap', 45.50, 9),
    (3, 'south', DATE '2026-01-01', 'cedar tea', 80.00, 2),
    (4, 'south', DATE '2026-02-01', 'linen towel', 210.00, 6),
    (5, 'east', DATE '2026-02-01', 'maple soap', 30.00, 3),
    (6, 'east', DATE '2026-01-01', 'linen towel', 64.00, 2);
```

### pq_revenue_by_region

Parameter: `month`, type `date`, required.

```sql
SELECT region, sum(amount) AS revenue
FROM demo_sales
WHERE month = :month
GROUP BY region
ORDER BY region
LIMIT 100
```

For `month = 2026-01-01` the rows are east 64.00, north 165.50, and south 80.00.

### pq_top_products

Parameters: `month`, type `date`, required, and `n`, type `int8`, required, maximum 20.

`:n` is a rank filter. It is not the `LIMIT`. The `LIMIT` is the literal `20`, which is required, and the maximum on `n` stops a caller from asking for more ranks than that `LIMIT` returns.

```sql
SELECT product, revenue
FROM (
    SELECT product,
           sum(amount) AS revenue,
           rank() OVER (ORDER BY sum(amount) DESC) AS rnk
    FROM demo_sales
    WHERE month = :month
    GROUP BY product
) ranked
WHERE rnk <= :n
ORDER BY rnk
LIMIT 20
```

For `month = 2026-01-01` and `n = 2` the rows are cedar tea 200.00, then linen towel 64.00.

## What this version does not do

-   A second person approving a pin.
-   Pins in Auto mode (`CUTTLELY_ANALYST=auto`). The isolated analyst store does not run them, and no `pq_` tools are registered.
-   A parameter that chooses `LIMIT`, `OFFSET`, `ORDER BY`, a column, or a table.
-   One shared `pinned_query` tool that takes a name. Each pin is its own tool.
-   Blocking a call because the columns drifted. v1 warns in the result that the pin needs a re-test.
