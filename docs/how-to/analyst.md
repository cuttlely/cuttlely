# Analyst mode

Analyst mode gives one specialist its own database. It can create tables, insert rows, and answer questions about that data. It does not read the application database, where users, credentials, and chat history live.

The switch is `CUTTLELY_ANALYST=auto`. Any other value, including unset, leaves it off. There is no button in the app.

Use it when a harness should look at business data you are willing to create for it, and must not see the tables Cuttlely uses to run.

Install first. A laptop install is [Docker](./docker.md) and stays on SQLite. Changing Cuttlely is [From source](./from-source.md). A public host is [Render](./render.md#analyst-database). The account is [Sign in](./sign-in.md). What a harness is: [Harnesses](./harnesses.md).

![The server process environment. CUTTLELY_ANALYST is auto, and a check for DATABASE_TYPE prints DATABASE_TYPE is unset.](../images/analyst/process-env-auto.png)

## Quick start

This path is a fresh checkout, SQLite, and a real OpenAI key saved in the app. Do not put the key in the shell or in git.

Node 24 (`.nvmrc` is `v24.15.0`), pnpm pinned by `packageManager` to 10.33.4, and [uv](https://docs.astral.sh/uv/). Corepack uses that pin. From the repo root:

```bash
pnpm install
pnpm build
bash scripts/setup-hermes.sh
CUTTLELY_LOCAL_ADMIN=true CUTTLELY_ANALYST=auto bash scripts/start-cuttlely.sh
```

Leave `DATABASE_TYPE` unset. That is SQLite. Unset `CUTTLELY_POSTGRES_URL` as well. A Postgres URL, or a Postgres URL credential on the node, turns the analyst into the read-only path and auto storage stays off. The script listens on port 43117. Open [http://localhost:43117](http://localhost:43117).

Create the account. In a terminal the password is read from a prompt and is not echoed. Without a terminal, `pnpm user` reads the password from stdin until the pipe closes. The rules are in [Sign in](./sign-in.md).

```bash
CUTTLELY_LOCAL_ADMIN=true pnpm user --email you@example.com
```

While the server is already running, that command can print `listen EADDRINUSE: address already in use 127.0.0.1:43118`. That port is the harness gateway, which the server already holds. The account command still finishes.

Open [http://localhost:43117/signin](http://localhost:43117/signin) and use **Sign in**.

### Credential

Open **Credentials**, choose **OpenAI API**, and paste a real key into **OpenAI Api Key**.

The harness uses that credential. You do not have to unset `OPENAI_API_KEY` in the server environment. Cuttlely passes the credential key into the chat model. If the OpenAI node has no credential, the run stops and does not read `OPENAI_API_KEY` from the environment. A key left in the environment does not fill in a missing credential.

### Harness

Open **Templates** and start **Chief of Staff Harness**.

Saving the raw template is rejected until the **xAI Grok** node has a credential, or you delete that node. The message is: `The xAI Grok chat model on Harness Prime needs a credential. Select one on that node and save the harness.`

Save it as `chief-of-staff`. A harness id is a letter, then letters, numbers, `_`, or `-`, up to 64 characters. The card title is not an id. Saving `Chief of Staff Harness` is rejected: `Harness name "Chief of Staff Harness" is not valid. Use a letter followed by letters, numbers, "_" or "-".`

On the canvas (`/harnesscanvas/:id`):

1. The sample Harness Prime model is **xAI Grok**, model `grok-4.7`, with no credential. If you saved an OpenAI key first, the template already shows **ChatOpenAI** with your key instead (see [Connect a chat model](./harnesses.md#connect-a-chat-model-to-harness-prime)); go to step 3. Otherwise delete that node, or the save above is rejected.
2. Add **OpenAI** from Chat Models. Under **Model Name**, choose a model. Under **Connect Credential**, select the OpenAI credential. Connect the node to **Harness Prime**.
3. Open **PostgreSQL MCP**. Under **Available Actions**, select **QUERY**. The sample stores no action. Until QUERY is selected, the node runs nothing. With QUERY selected, the line under the field is the action description. In auto mode that line starts with `Run one SQL statement in the isolated analyst store`. That sentence is the sign auto mode is on. Opening the list shows the same description under **QUERY**. `Run a read-only SQL query` means a Postgres URL or a Postgres URL credential is set. In auto mode, with no credential saved, **Connect Credential** reads `Auto mode: isolated analyst store, no credential needed`.
4. Save.

A harness saved before the handle-id repair still has the old edge ids in stored JSON. The canvas repairs those ids when it loads, and **Try it** and the runs API already accept them. You do not have to re-save before a run. Saving the canvas writes the new ids.

Each specialist **Chat Model** input can stay empty. The specialist uses Harness Prime's model. An orange triangle on the card is the outdated-node notice when the saved version is behind the current Harness Specialist or Harness Prime. It is not a missing chat model. A harness made from the template today shows no triangle. One saved from an older template or an older Cuttlely shows it until you select **Sync Nodes** and then save. Saving without **Sync Nodes** leaves it.

![The chief-of-staff harness canvas in the dark theme, with the PostgreSQL MCP card in view. Available Actions has QUERY selected with its description below, Connect Credential reads Auto mode: isolated analyst store, no credential needed, and Tables and views says isolated analyst storage has nothing to pick.](../images/analyst/postgres-mcp-query.png)

**Try it** is on `/harnesses/chief-of-staff`. The chat on the harness canvas (`/harnesscanvas/<id>`) and **Try it** run the draft when one exists, and Live otherwise. They do not build the canvas as a chatflow. External callers use `POST /api/v1/harnesses/chief-of-staff/runs`, which stays on Live until you publish. The trace on that page shows who ran, the model, and tool names with done, retried, or failed chips. An analyst query chip also shows how many rows that query returned, and a short preview of them. The answer shows the rows and, when the tool stopped at the cap, a page line such as `rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)`. The raw tool text is also in the agent runtime profile database, `state.db`, under that specialist. The panel is described in [Harnesses](./harnesses.md).

This is the canvas chat after the sales prompt from [Prompts](#prompts). The Run card names the analyst, its model, and the tool count. The answer shown here opens with the totals by region before the update.

![Harness canvas for chief-of-staff in the dark theme, with the chat panel open. The sales prompt was sent, the Run card says Harness Prime sent work to analyst, the analyst row is done with 6 tools, and the visible answer is Total units by region before the update: west 15, east 20.](../images/analyst/canvas-chat-sales.png)

Docker is the same switch in `.env`, then `docker compose up -d`. The workspace file lands at `/var/cuttlely/data/analyst-<tag>.db`, beside `database.sqlite`. `<tag>` is 10 hex characters from the workspace id. See [Docker](./docker.md) and [Workspaces](#workspaces).

## SQLite

With `CUTTLELY_ANALYST=auto`, and no Postgres URL credential or `CUTTLELY_POSTGRES_URL`, the first time the analyst tool starts it creates that workspace's `analyst-<tag>.db` beside `database.sqlite`. A store from before workspaces, `analyst.db`, stays with the first workspace that uses it. [Workspaces](#workspaces). The tool opens only that workspace's file.

When `DATABASE_PATH` is unset, that directory is `~/.cuttlely`. `scripts/start-cuttlely.sh` does not move the app database. Harness files for this checkout are under `<repo>/.cuttlely`. The split is in [From source](./from-source.md#where-your-data-lives).

Tables you create in `analyst.db` are not in `database.sqlite`. New application rows can sit in `database.sqlite-wal` until SQLite checkpoints, so a small `database.sqlite` does not mean the app database is empty. It also does not mean the analyst tables are in it.

SQLite uses the same row cap and the same query timeout as Postgres. Both default to 100 rows and 15 seconds. SQLite itself cannot stop a running statement, so Cuttlely runs analyst statements in a small separate process. A statement still running when the timeout is up stops that process. The unfinished change is rolled back, the chat shows `canceling statement due to statement timeout`, and the next statement starts a fresh process. The server keeps answering other requests while it waits. [Row cap and query timeout](#row-cap-and-query-timeout).

An id column has to be `INTEGER PRIMARY KEY`. `SERIAL` is not a SQLite type. A column declared that way comes back null. The analyst tool says which dialect it is on. On SQLite it says to use `INTEGER PRIMARY KEY`.

![An analyst database file named analyst- and a short hash, beside database.sqlite. The count of tables named sales or tickets in database.sqlite is 0. The analyst file's .tables lists sales, tasks, and tickets. sales is 1 west 10, 2 east 20, 3 west 5. tickets is Ticket 1, Ticket 2, and Ticket 3.](../images/analyst/sqlite-analyst-db.png)

## Postgres

Use this when the application database is already Postgres. The variables are in [From source](./from-source.md#use-postgres). Add `CUTTLELY_ANALYST=auto` to that start. The application user must be allowed to create roles. Render often is not. That case is [Fail closed](#fail-closed).

The account lives in the application database. After you point Cuttlely at Postgres, create the local account again. [Sign in](./sign-in.md).

The first time the analyst tool starts for a signed-in workspace, Cuttlely creates schema `analyst_<tag>` and login `analyst_reader_<tag>` in the application database. The login can sign in. It is not a superuser, and it cannot create roles or databases. Its `search_path` is that schema. Its `statement_timeout` is the query timeout (`15s` unless you change it). A store from before workspaces, schema `analyst` and login `analyst_reader`, stays with the first workspace that uses it. [Workspaces](#workspaces). Cuttlely also sets both on every analyst connection, so they hold even if the analyst changes its own login's defaults. It can create and change tables in `analyst_<tag>`, and it can make TEMP tables, which last for one harness turn. It cannot read application tables. `<tag>` is 10 hex characters derived from the workspace id.

The role password is random. It is stored in `analyst-role-<tag>.enc` under `SECRETKEY_PATH`, mode `600`, encrypted with the credential key. The original untagged store uses `analyst-role.enc` instead, and its rows stay in schema `analyst`. When `SECRETKEY_PATH` is unset, that directory is `~/.cuttlely`. Docker and Render set the directory. [Docker](./docker.md). It is not an environment variable and it is not written to the server log. A restart reuses that file. It does not create a second role, and rows already in `analyst_<tag>` stay.

![psql on the cuttlely database. \dn analyst* shows one schema, analyst_ and a short hash, owned by the cuttlely login. The role list has one matching analyst_reader_ role, which is not a superuser and cannot create roles, with statement_timeout=15s and search_path set to that schema.](../images/analyst/postgres-analyst-role.png)

Ask: `Show the analyst login and search_path.`

You should see login `analyst_reader_<tag>` and search path `analyst_<tag>`. The model may phrase that in its own words. The run trace has the tool result.

## Workspaces

Each workspace has its own analyst store. Tables one workspace's analyst makes are not visible to another workspace's analyst.

| Store    | Per workspace                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite   | `analyst-<tag>.db` beside `database.sqlite`. `<tag>` is 10 hex characters derived from the workspace id.                                                               |
| Postgres | Login `analyst_reader_<tag>` and schema `analyst_<tag>`, with the same limits as `analyst_reader`. Its password is in `analyst-role-<tag>.enc` under `SECRETKEY_PATH`. |

A store made before workspaces had their own, `analyst.db` or login `analyst_reader` with schema `analyst`, stays with the first workspace whose analyst runs. Cuttlely writes that workspace's tag into `analyst.db.workspace`, or into the stored Postgres secret. Every other workspace starts with an empty store of its own. A call that names no workspace uses that original store.

A page cursor belongs to its workspace's store. `show more` in another workspace gets `This page cursor is not valid. Re-run the query.`

On Postgres, the owner of a table can share it with every login. The analyst's own store refuses `GRANT`, `REVOKE`, `DO`, `ALTER DEFAULT PRIVILEGES` and `SECURITY DEFINER` with `Analyst mode refused GRANT, REVOKE, DO and SECURITY DEFINER. Each workspace keeps its own analyst area.` That is an expected result, so it does not pause the analyst tool.

The same statement in two teams of one server. In the home team, whose analyst had already made `demo_orders`, it returns 150:

![Try it on the bakery-auto-timeout harness. The prompt is SELECT count(*) AS n FROM demo_orders. The Run card says Harness Prime sent work to analyst, the analyst row is done with 1 tool, and the answer is The query returned a count of 150 rows in the demo_orders table.](../images/analyst/workspace-home-team.png)

A copy of that harness in a second team, Demo team B, gets its own `analyst-<tag>.db`, and the table is not there:

![Try it on the bakery-team-b-auto harness. The same statement fails. The analyst row is done with 1 tool, the answer is The query failed because there is no table named demo_orders in the database, and the Runs list marks that run completed with errors.](../images/analyst/workspace-second-team.png)

## Prompts

On `/harnesses/chief-of-staff`, **Try it**. These need `CUTTLELY_ANALYST=auto` and no `CUTTLELY_POSTGRES_URL` or Postgres URL credential. An explicit URL is read-only and will not create tables. See [Which setting wins](#which-setting-wins).

Sales:

```text
Use the analyst database. Create a sales table with id, region, and amount. Insert west 10, east 20, and west 5. Show the total amount by region. Then add 10 to every west amount and show all rows.
```

The table should end as west 20, east 20, and west 15. West started at 10 and 5, then each west amount increased by 10.

Row cap:

```text
Use the analyst database for a row cap check. Create a tickets table and insert 150 rows, then select all rows.
```

The model writes the INSERT itself. Check the row count the tool reports. A first try can insert fewer than 150 rows and say so. When the insert is 150, the tool returns 100 rows and `truncated: true`. The table still holds 150. The tool result includes `rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)`. Harness Prime's answer keeps those rows, or a list capped at the rows the tool returned, and that page line word for word. A short paraphrase such as "the select returned 100 rows" is not the answer. The handoff keeps that line even when the rest of the prompt is shortened. The trace shows the tool name, a done, retried, or failed chip, the row count, and a short preview of the rows. A `tool_call · retried` chip is a batched local call the agent runtime rejected; the reason is on the chip, and the specialist then calls the tool once.

What that answer looks like, and how to get rows 101-150, is in [Paging through large results](#paging-through-large-results).

## Paging through large results

A select longer than 100 rows comes back one page at a time. The first answer is rows 1-100. The page line after the rows tells you which page you are on.

These shots are a 150-row `tickets` table. The first two are the canvas chat. The prompt creates the table and selects every row:

![Canvas chat with the prompt that creates a tickets table, inserts 150 rows, and selects all rows. The Run card says Harness Prime sent work to analyst, the analyst row is done with 4 tools, and the answer says the table was created with 150 rows and lists them from id: 1, title: Ticket 1.](../images/analyst/paging-page-1-start.png)

The end of the first answer is row 100 and the page line:

![The end of page 1 in the canvas chat: a table of tickets that ends at Ticket 100, then the line rows 1-100 of 150 (page 1 of 2, say "show more" for the next page).](../images/analyst/paging-page-1-line.png)

In that same chat, say `show more`, `next page`, or `page 2`. That fetches the next page of the same select. It does not run a new query, and the model does not see the earlier pages again.

The last page reads `rows 101-150 of 150 (page 2 of 2, last page)`. With 101 rows and a limit of 100, page 2 is the single row 101. If the total is expensive or unknown, the line says `more rows available` and does not invent a count.

![Try it after show more. The prompt is show more. The Run card says Harness Prime sent work to analyst, and the answer lists tickets from id 101 onward, including Ticket 127 and Ticket 128, on the way to the last page.](../images/analyst/paging-page-2-last.png)

An answer that fits on one page has no page line and nothing to page. That includes a count or a total, which is one row. Say `show more` in a chat that has no capped result yet, and Harness Prime answers directly without running the analyst: `There's nothing to page yet. Ask your question again and I'll show the first page.`

![A canvas chat. How many rows are in the tickets table is answered with The tickets table contains 150 rows, with no page line. Then show more gets the direct reply There's nothing to page yet. Ask your question again and I'll show the first page.](../images/analyst/paging-nothing-yet.png)

The cursor lasts 15 minutes. It is dropped when Cuttlely restarts. It works only in the chat that ran the query. After 15 minutes, `show more` gets the direct reply `This page cursor expired. Re-run the query.` Send the question again for a new first page. A bad cursor, or one from another chat, also says to re-run the query. That message is an expected result, so it does not pause the analyst tool.

### Query preview on the run card

The answer can show only the top rows, for example the top 10 accounts. The run card shows how many rows the query returned and a short preview. That preview never includes rows past the configured row cap (at most 1000). Open the analyst row and select a query chip that says `· N rows`. The table starts closed.

The preview is the first few rows and the first few columns. A long value is cut short. When the preview is shorter than a finished page that has no page line, the caption says `Showing 5 of 40 rows. The answer can show fewer rows than the query returned.` The answer can name the top rows and leave the rest out. When the result has a page line, including a last page, and the question asks for the rows, the caption says the rest of these rows are in the answer in this chat. A count or a total, such as `How many tickets are in the table?`, does not. The caption says the answer can show fewer rows instead. It uses the question saved on the trace when that question was stored in full. Before the final event, Try it uses the prompt that was sent. The canvas chat uses the previous user message when the trace has no question. An older saved run still uses a short input preview that was not cut. The claim is withheld only when the trace question and those fallbacks are all empty. A question cut so the trace could be saved does not count, and neither does an input preview cut at 240 characters. It does not link away from the chat. It adds `Say show more for the next page` only when the analyst marked that result truncated. The page line under the table is the same line as in the answer, such as `rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)`.

The preview is saved with the run trace, in **Try it**, in the canvas chat, and in a saved chat. It holds only rows that query already returned to this chat, in this workspace, and never more than the configured row cap (at most 1000). It does not hold the page cursor. Select the chip again to close it. A run saved before previews still opens. Its chips render, and a chip that already stored its rows still lists those rows.

To leave row values out of new traces, turn off **Query previews in the run trace** under **Admin** > **Server Settings** > **Analyst**, then restart. The chip can still say how many rows came back. [Server settings](./server-settings.md).

![Try it on the chief-of-staff harness. The analyst row is open. The chip reads mcp__analyst__query · done · 100 rows. The preview shows id and title for Ticket 1 through Ticket 5. The caption says Showing 5 of 100 rows. The rest of these rows are in the answer in this chat. Say show more for the next page. The page line reads rows 1-100 of 150 (page 1 of 2, say "show more" for the next page).](../images/analyst/trace-query-preview.png)

A chip for a create, an insert, or a failed statement has no preview.

The row cap itself is the **Row cap** rule under [Safety](#safety). The default is 100 rows and the server never uses more than 1000. The trace and the page line are also covered in [Harnesses](./harnesses.md).

## Pick the tables and views the analyst sees

A database description pasted into the specialist's instructions travels with every prompt, whatever the question. The table picker replaces it. You tick the tables and views the analyst may use. The analyst gets one short line for each with its column names, reads the column types and keys of one when it needs them, and cannot query anything else.

This works on a database the node connects to by URL: a Postgres URL credential on the node, or `CUTTLELY_POSTGRES_URL`. Isolated analyst storage (`CUTTLELY_ANALYST=auto`) holds only the analyst's own tables, so the field says **Isolated analyst storage** and there is nothing to pick. The examples below use the made-up bakery database in `samples/demo/bakery/bakery-postgres.sql`.

### Tick tables and views

Open the **PostgreSQL MCP** card. **Tables and views** lists every table, view and materialized view the credential's login can read. Materialized views come first, then views, then tables, because a view usually answers a question in one step. Each row has the name, the kind, the column count, and the comment from `COMMENT ON`, when there is one. With eight or more rows there is a filter box. **Tick All** ticks the rows the filter shows, and **Clear** unticks everything. The refresh button lists the database again.

![The Tables and views field on the PostgreSQL MCP card in the dark theme. A filter box, Clear, Tick All and a refresh button sit above the list. public.monthly_sales and public.top_products are materialized views with 6 and 3 columns, public.account_balances is a view with 6 columns, and all three are ticked with their comments under the names. public.open_orders is a view and is not ticked. The line under the list reads 6 of 20 ticked. Queries that read anything else are refused.](../images/analyst/postgres-mcp-table-picker.png)

Save the harness. The selection is stored on the node as the list of names. A PostgreSQL MCP card saved before this field existed shows the orange outdated-node triangle. Select **Sync Nodes** and save to add the field.

-   **Nothing ticked** keeps the behavior from before the picker: the analyst can query every table the login can read, and there is no describe tool.
-   **A ticked name the database no longer has** stays in the list, marked **Not in this database any more**, until you untick it. If none of the ticked names exist, every query is refused with `None of the selected tables or views exist any more. Update the selection on the PostgreSQL MCP node.` The analyst does not fall back to every table.

### What the model sees

The query tool's description ends with one line per ticked relation: the name, the kind, its column names, and the comment. For the six bakery relations in the picture:

```text
Only these relations can be queried. Each line lists its column names, the first 12 when there are more. Call describe with a name for column types and comments, keys, the full column list and a view definition.
- public.monthly_sales (materialized view): month, store, product, category, units, revenue — Shop sales per month, shop and product. Refreshed nightly.
- public.top_products (materialized view): product, units, rank — Products ranked by units sold, not revenue, over all shops and weeks. For revenue use monthly_sales.
- public.account_balances (view): account_id, account_code, name, credit_limit, unpaid_invoices, balance_due — What each wholesale account owes. Look up account_id by account_code first.
- public.weekly_store_revenue (view): week_start, store, units, revenue — Shop revenue per week. Use for shop sales questions.
- public.wholesale_accounts (table): id, account_code, name, city, credit_limit — Cafes and grocers that buy wholesale
- public.stores (table): id, name, address, opened_on — Bakery shops
```

The column names are there because models often write SQL before they call describe, whatever the instructions say. A run with a real model guessed column names, failed, and only then described the view. With the names in the line, the first query can be right. A relation with more than 12 columns lists the first 12 and then `…`. Column names that need quotes are listed quoted. A newline in a name or comment is shown as a space. Types, column comments, keys and view definitions stay in `describe`.

A comment longer than 120 characters is cut. Write the comment that tells the analyst when to use the relation, and when not to, as `account_balances` and `top_products` do above. That line is the routing hint the model reads on every question. Say what a relation ranks or totals by: in the same real-model run, a comment that said only "ranked by units sold" was read as a revenue ranking.

### The describe tool

With at least one relation ticked, the node also offers **describe**. It is not in **Available Actions** separately: it comes with **QUERY**. It takes one name from the list, with or without the schema, and returns:

| Field           | What it holds                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`, `kind`  | The schema-qualified name, and table, view, materialized view or foreign table                             |
| `comment`       | The relation's comment, when there is one                                                                  |
| `columns`       | One line per column: name, type, `not null`, and the column comment after `--`                             |
| `primaryKey`    | The primary key columns of a table                                                                         |
| `relationships` | Foreign keys between ticked relations, which ticked relations a view reads, and which ticked views read it |
| `definition`    | The definition of a view or materialized view, cut at 4,000 characters                                     |

`describe` for `account_balances` with the six relations above:

```json
{
    "name": "public.account_balances",
    "kind": "view",
    "comment": "What each wholesale account owes. Look up account_id by account_code first.",
    "columns": [
        "account_id integer",
        "account_code text",
        "name text",
        "credit_limit numeric(10,2)",
        "unpaid_invoices bigint",
        "balance_due numeric"
    ],
    "definition": "SELECT a.id AS account_id, a.account_code, ... FROM wholesale_accounts a LEFT JOIN invoices i ON i.account_id = a.id GROUP BY a.id;",
    "relationships": ["reads public.wholesale_accounts"]
}
```

`invoices` is not ticked, so it is not named under `relationships`, although the view definition reads it. A name that is not ticked is refused: `payroll_notes is not one of the selected tables or views. Choose one of: public.monthly_sales, ...`. A bare name that two ticked relations share in different schemas is refused as ambiguous: `stores is ambiguous: it matches sales.stores, public.stores. Call describe again with the schema-qualified name.` Column names that need quotes come back quoted, such as `"Unit Price" numeric(8,2)`.

The run card shows each call as its own chip. In the picture below, a scripted stand-in model (`scripts/docs-shots/model-stand-in.mjs`) drove the analyst instead of a real provider model, so the order of calls is scripted, and the token counts and timings on the card are illustrative. It shows how a describe call and a query appear on the run card. It does not show what a real model chooses to do. Here the stand-in described the view, then queried it:

![Try it on the bakery-accounts harness, run by a scripted stand-in model, so the token counts and timings are illustrative. The prompt is How many unpaid invoices does account WA-1004 have? The Run card says Harness Prime sent work to analyst, and the analyst row is open with 2 tools. Its chips read mcp__analyst__describe · done and mcp__analyst__query · done · 1 row. The answer is WA-1004 (Hilltop Deli) has 3 unpaid invoices.](../images/analyst/try-it-describe-trace.png)

### How the selection is enforced

The selection is checked by Postgres, on the server, for every query and every `show more`, before the statement runs. The model's text is not trusted to stay inside the list.

1. Only `SELECT`, `WITH`, `VALUES` and `TABLE` statements run. Anything else is refused with `This node limits the analyst to selected tables and views, so it runs only SELECT, WITH, VALUES and TABLE queries.`
2. Cuttlely looks for risky domains in the database, from the catalog alone and before the statement is parsed. If there are any, every query is refused (see below). The result is kept for one minute per database.
3. In the same transaction, Cuttlely creates a temporary view over the statement. Postgres parses it and resolves every name exactly as it would run it. Until step 6 the transaction can write: what runs then is the parse, the temporary view and the catalog reads below.
4. Cuttlely reads that view's stored query tree. It names every relation, function and operator the statement uses, including those inside a `WITH`, a subquery, a system catalog such as `pg_class`, and `information_schema`.
5. The query is refused when:
    - it reads a relation that is not ticked;
    - it calls a function or operator that is not built in (outside `pg_catalog`);
    - it calls a built-in that can reach other data, report on objects outside the selection, act on other sessions, or change how names resolve: `query_to_xml` and the other `*_to_xml` functions, `ts_stat`, `set_config`, `pg_input_is_valid` and `pg_input_error_info`, `obj_description`, `col_description` and `shobj_description`, the `pg_stat_get_*` statistics, `pg_relation_size` and the other size functions, `pg_get_*` definitions, `has_*_privilege`, `*_is_visible`, `to_reg*`, `pg_terminate_backend` and `pg_cancel_backend`, large-object and file functions, and `dblink`;
    - it uses a type whose input, output, receive or send function is outside `pg_catalog` (an extension type such as `citext`), or an object-identifier type such as `regclass`. The check follows a domain's base type, an array's element, a composite type's columns and a range's subtype.
6. The temporary view is dropped, the transaction turns read only, and the statement runs. The transaction always ends with a rollback, so the temporary view and anything else that transaction changed is undone. A sequence advanced by `nextval` is the exception, which is one reason a domain check that calls it counts as risky.

A refusal is an expected result, like a syntax error, and the analyst can quote it:

> Cuttlely refused this query: it reads public.payroll_notes, which this node's table selection does not include. Selected: public.monthly_sales, public.top_products, public.account_balances, public.weekly_store_revenue, public.wholesale_accounts, public.stores.

When a query fails because a column does not exist or is ambiguous, the error ends with the columns of each ticked relation the statement names, so the next try can use the right name:

> column "revenue" does not exist. Columns of public.top_products: product, units, rank.

A relation counts when the statement names it, with the schema or without, quoted or not. That list stops at 60 names. Other errors, such as a syntax error, come back as Postgres wrote them.

A ticked view is the gate. Its own definition is not expanded, so `account_balances` can read `invoices` while `invoices` stays unticked and `SELECT * FROM invoices` is refused. Tick views and leave their base tables unticked when the view is all the analyst should see.

Why not a separate login or `search_path`: a `search_path` does not stop a schema-qualified name, and a login with grants on only the ticked relations would need Cuttlely to create roles in your database, which a read-only credential usually cannot do. The check above needs only what the credential already has, plus the right to create a temporary view.

**Risky domains.** A literal of a composite, array or range type (`'{5}'::quiet_ref[]`) runs its element's input while Postgres parses the statement, and a domain element runs its `CHECK` then, in step 3, before Cuttlely can see the query tree. So a database with a risky domain refuses every query while a selection is set, whatever the statement, with the same text and without parsing it:

> Cuttlely refused this query: this database has domains whose CHECK could run other code or change data while a query is checked: public.quiet_ref. Queries are refused while a table selection is set. Change those CHECK constraints to built-in functions that are not volatile, or clear the selection on the PostgreSQL MCP node.

A domain is risky when its `CHECK` calls a volatile function (such as `nextval` or `random`), a function or operator outside `pg_catalog`, a built-in from the deny list above, or uses an object-identifier type or a type whose input or output is outside `pg_catalog`. Domains are checked in every schema the database has, not only the ticked relations, because any of them can be named in a literal. A domain whose `CHECK` uses only built-in, non-volatile functions and operators, such as `CHECK (VALUE >= 0)`, is fine. To fix a risky domain, rewrite its `CHECK` with built-in functions that are not volatile (`ALTER DOMAIN ... DROP CONSTRAINT`, then `ADD CONSTRAINT`), move the rule into the application or a trigger on the tables that use it, or clear the selection on the node. A fix shows up within a minute. The other way round, a risky domain created within a minute after a scan can still run its check while a statement is parsed, until the next scan finds it.

The check is tested against Postgres 14, 15, 16, 17 and 18.

Limits of the check:

-   The login needs `TEMP` on the database, which Postgres grants to every login by default. A read replica (hot standby) cannot create a temporary view, so with a selection set every query there is refused with `Cuttlely could not check this query against the table selection: this database login cannot create a temporary view (a read replica, or no TEMP privilege). Queries are refused while a selection is set.` Point the credential at the primary, or clear the selection.
-   Functions, operators and types from extensions installed outside `pg_catalog`, such as `similarity()` from `pg_trgm` or a `citext` or PostGIS column, are refused while a selection is set, including when a query only reads a column of that type. Expose such a column through a ticked view that casts it to a built-in type.
-   One risky domain anywhere in the database stops every scoped query there, including queries that never touch it.
-   A view you tick runs with its owner's rights, as Postgres always runs views. Whatever its definition reads, the analyst can read through it.

### Add your own routing in the instructions

The lines and `describe` tell the analyst what exists. How to choose between relations is yours to write, in the analyst specialist's **Instructions** on the canvas. Keep it short and about choices, not columns. The analyst instructions in the bakery picture above are:

```text
Answer bakery questions from the selected tables and views.
Pick the view that matches the question: account_balances for what an account owes, monthly_sales for sales by month, weekly_store_revenue for a shop by week.
A question that names an account code such as WA-1004 is about that account. Look up its account_id in wholesale_accounts first when the view needs the id.
Describe a view before the first query against it.
```

The same pattern fits any database: name the relation that answers each kind of question, name the lookup that has to come first (an id from a code, a date range from a week name), and leave the columns to `describe`. A routing rule that is long or only matters for some questions can be a [playbook](./context-and-tokens.md#playbooks-load-when-a-question-needs-them) instead, so it loads only when a question needs it.

### How many tokens it saves

`scripts/analyst-schema-tokens.mjs` measures the bakery database. It compares the whole database written into the instructions with the picker. On the bakery database, with the o200k_base encoding:

| Prompt part                                                        | Tokens |
| ------------------------------------------------------------------ | -----: |
| Whole schema in the instructions, plus the query tool              |  2,562 |
| Six relations ticked: the query tool with six lines, plus describe |    643 |
| All 20 relations ticked                                            |  1,004 |
| One `describe` result, `account_balances`                          |    172 |

The schema part alone goes from 2,235 tokens to 235. The six lines cost 76 tokens more than the earlier format, which gave a column count instead of names (567 in total), and that includes the longer `top_products` comment. They save a failed query and a retry when the model writes SQL before it describes. A `describe` result is a tool result, so it costs tokens only in the turn that calls it. The bakery database is small; the whole-schema figure grows with every column and comment, and the picker's grows by one line per ticked relation, with at most 12 column names in a line.

```bash
psql -d bakery -f samples/demo/bakery/bakery-postgres.sql
CUTTLELY_BAKERY_URL=postgresql://127.0.0.1:5432/bakery node scripts/analyst-schema-tokens.mjs
```

A URL without a login uses `PGUSER` and `PGPASSWORD` from the environment.

## Safety

| Rule                     | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own store                | SQLite uses `analyst.db` only. Postgres uses schema `analyst` and login `analyst_reader`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Application tables       | On Postgres, `SELECT` from `public."user"` returns `permission denied for schema public`. On SQLite the tool never opens `database.sqlite`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Application database URL | A credential or `CUTTLELY_POSTGRES_URL` that is the application database is refused. Auto storage does not take over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Statement timeout        | Every analyst statement stops after the query timeout, 15 seconds unless you change it. On Postgres and on SQLite, `SELECT pg_sleep(20)` fails with `canceling statement due to statement timeout` while the timeout is 15 seconds. The chat shows that sentence. [Statement timeout](#statement-timeout).                                                                                                                                                                                                                                                                                                                                                           |
| Row cap                  | A result returns at most the row cap, 100 rows unless you change it. A lower cap puts fewer rows into the specialist's prompt. The tool sets `truncated` to `true` and adds a page line such as `rows 1-100 of 150 (page 1 of 2, say "show more" for the next page)` when it knows the total. If the total is unknown, the line says `more rows available`. [Paging through large results](#paging-through-large-results). [Row cap and query timeout](#row-cap-and-query-timeout).                                                                                                                                                                                  |
| Explicit URL             | `CUTTLELY_POSTGRES_URL` and a Postgres URL credential run **QUERY** as `Run a read-only SQL query`. They do not create or change tables. Each call opens a read-only session with the server query timeout, and results get the same row cap, page line and `show more` paging as auto storage. The analyst and Harness Prime are told the database is PostgreSQL and read-only, even on a server that runs on SQLite. Because nothing can change, a failed statement gets one fix: the analyst reads the SQL error, corrects the statement and runs it once more. A second failure, or a refusal, stops that step. The trace shows a failed chip, then a done chip. |
| Table selection          | With tables or views ticked on the node, a query that reads anything else, calls a function, operator or type outside `pg_catalog`, calls a denied built-in, or is not a read is refused before it runs. Nothing ticked allows every table the login can read. [How the selection is enforced](#how-the-selection-is-enforced).                                                                                                                                                                                                                                                                                                                                      |
| Auto                     | `CUTTLELY_ANALYST=auto`, with neither of those set, runs `Run one SQL statement in the isolated analyst store`. That path can create and change tables in the isolated store. The description also names SQLite or PostgreSQL.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SQLite file writes       | The analyst store refuses `ATTACH`, `DETACH`, `VACUUM`, `load_extension`, and file-writing PRAGMAs. The query tool returns that refusal, and the chat quotes it. The text starts with `Analyst mode refused`. A refusal, and an ordinary SQL error such as `no such table` or a syntax error, is an expected result. It does not pause the analyst tool. Normal `CREATE`, `INSERT`, `UPDATE`, `SELECT`, and `DROP` in `analyst.db` still run.                                                                                                                                                                                                                        |
| Postgres file reads      | Login `analyst_reader` is not a superuser and is not a member of `pg_read_server_files`, `pg_write_server_files`, or `pg_execute_server_program`. `COPY ... TO PROGRAM`, `pg_read_file`, and `lo_export` are denied.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Other SQL servers        | A harness specialist is offered SQL only through PostgreSQL MCP. A tool from any other MCP server that runs SQL is not offered, and a call to it returns `Cuttlely refused this SQL tool. Its MCP server cannot list or limit the tables it reaches. Use the PostgreSQL MCP node for SQL.` [Other SQL tools](#other-sql-tools).                                                                                                                                                                                                                                                                                                                                      |

In **Try it**, `VACUUM INTO` a file path comes back as the refusal, word for word. The run finishes and the analyst chip is done:

![Try it on the chief-of-staff harness page. The prompt asks the analyst to run VACUUM INTO a file in /tmp, and the answer quotes Analyst mode refused ATTACH or VACUUM. The analyst store cannot open another file. In the Runs list that run is marked completed with errors.](../images/analyst/try-it-vacuum-refused.png)

Unqualified `"user"` looks only in schema `analyst` and returns that the relation does not exist. That is `search_path`, not a grant on `public`. Table names can still show up in `pg_catalog`. The analyst still cannot select those tables.

### Row cap and query timeout

**Admin** > **Server Settings** > **Analyst** sets both. They apply on the next start. The defaults are the limits this guide's examples use: 100 rows and 15 seconds.

| Setting           | Variable                                | Default    | The server allows |
| ----------------- | --------------------------------------- | ---------- | ----------------- |
| **Row cap**       | `CUTTLELY_ANALYST_ROW_CAP`              | 100 rows   | 1 to 1000 rows    |
| **Query timeout** | `CUTTLELY_ANALYST_STATEMENT_TIMEOUT_MS` | 15 seconds | 1 to 120 seconds  |

A lower row cap means less context. The specialist's prompt and the handoff Harness Prime reads contain that one page, not the rest of the table. The rows stay in the database. Say `show more` for the next page. A higher cap, up to 1000, puts more of the table into the prompt and costs more tokens. The server treats a value above 1000 as 1000, and a timeout above 120 seconds as 120 seconds. A query timeout below 1 second is raised to 1 second. Zero, a negative number, or text that is not a number is ignored for either setting, the default is used, and the server logs that once. A page that does not fit the handoff budget shows only the rows that fit, and the next page starts at the following row.

On the **PostgreSQL MCP** node, **Additional Parameters** has **Row cap** and **Query timeout (seconds)**. Leave them empty to use the server settings. A number there can be lower. It cannot be higher than the server setting. The same two limits apply to auto storage and to a Postgres URL.

The query timeout is set on each call:

-   Auto Postgres sets it when the connection starts. That wins over the login's default, so `ALTER ROLE analyst_reader SET statement_timeout TO 0` from the analyst changes nothing. The next statement still stops at the server timeout.
-   A Postgres URL sets it inside the read-only transaction.
-   SQLite runs the statement in a separate process and stops that process when the timeout is up.

A timeout is an ordinary result, like a syntax error. It does not pause the analyst tool for the chat. The analyst can shorten the query and try again. Inside a harness, a turn still has its own 45-second budget. [Server settings](./server-settings.md#analyst-limits).

### Statement timeout

With the default query timeout, 15 seconds is the limit for every analyst statement. Cuttlely sets it on each call, as [Row cap and query timeout](#row-cap-and-query-timeout) describes. The picture below is that default.

In **Try it** on a harness whose analyst uses the workspace analyst file, a recursive count with no end stops at 15 seconds. The answer quotes the timeout sentence. The analyst row in the picture finished in 16 seconds, and the server kept answering the whole time:

![Try it on the chief-of-staff harness. The prompt asks the analyst to run a recursive count with no end. The Run card says Harness Prime sent work to analyst, the analyst row is done on OpenAI gpt-5.6-luna with 1 tool, and the answer is The analyst database query failed: canceling statement due to statement timeout.](../images/analyst/statement-timeout-sqlite.png)

### Temporary tables

In a harness turn, the analyst keeps one connection to its own store from its first query to the end of the turn. A `CREATE TEMP TABLE` from one step is still there for the next step, so the analyst can set a small result aside and join it with another table. Other chats cannot see it. When the turn ends, Cuttlely closes that connection, and SQLite or Postgres drops the turn's temporary tables. A turn that never finishes cleanly lets go after 10 idle minutes.

-   Temporary tables are made only in the analyst's own store, `analyst.db` or the `analyst_reader` login. A Postgres URL source is read-only. `CREATE TEMP TABLE` there fails with `cannot execute CREATE TABLE AS in a read-only transaction`.
-   Each statement still commits on its own. A `BEGIN` does not hold a transaction open into the next step.
-   On SQLite, a statement stopped at the timeout also ends that turn's connection and its temporary tables. On Postgres they stay until the turn ends.
-   Outside a harness, such as a chatflow that calls the node directly, every call has its own connection. A temporary table lasts one call there. Use a regular table in the store instead.
-   `show more` is a new turn. To page through more than 100 rows later, select from a regular table, not a temporary one.

In **Try it** on a SQLite auto store, one turn creates `tmp_targets`, fills it, and joins it with the regular table `demo_orders`. The three query chips are three separate tool calls on the same connection:

![Try it on the chief-of-staff harness. The Run card says Harness Prime sent work to analyst, the analyst row is done with 3 tools, and the answer is apple tart 650 ordered, target 900; lemon cake 650, target 400; rye loaf 650, target 300. The Runs list below starts with the prompt that creates tmp_targets and joins it to demo_orders.](../images/analyst/temp-table-join.png)

The next turn in the same chat runs `SELECT * FROM tmp_targets;` and gets `no such table: tmp_targets`:

![The next run in the same Try it chat. The prompt is SELECT * FROM tmp_targets. The analyst row is done with 1 tool, and the answer is The analyst query failed: no such table: tmp_targets.](../images/analyst/temp-table-next-turn.png)

## Other SQL tools

Cuttlely can list and limit the tables the analyst reaches only through its own PostgreSQL MCP node. Another MCP server that runs SQL reaches every table its own login can. So a harness specialist does not get those tools:

-   **Custom MCP node, or any node in Tools (MCP).** Cuttlely lists the server's tools. A tool that takes a `sql` or `statement` field, or says SQL in its name, description or fields, is left off the specialist's tools. So is a tool that names a database engine, such as Postgres, MySQL, SQLite or Snowflake, and takes a `query` field. Its other tools still work. A call to a refused tool returns the refusal sentence, and the server log reads `refused SQL tool <name>`.
-   **A server typed into the specialist's MCP servers.** That server goes straight to the agent loop, so Cuttlely never sees its tools. A server whose name, command or arguments name SQL or a database engine is not started. The server log reads `refused MCP server <name>`.

The rule goes by names and fields. A server that runs SQL under a name that says neither is not caught, so connect databases through PostgreSQL MCP.

![Try it on bakery-other-sql. The prompt asks how many sourdough orders the bakery had and to use the execute_sql tool. The analyst row is done with no tool chip, and the answer is The analyst was unable to access the execute_sql tool, so the number of sourdough orders is unavailable.](../images/analyst/sql-refused.png)

## Which setting wins

1. A Postgres URL credential on the node.
2. `CUTTLELY_POSTGRES_URL`.
3. `CUTTLELY_ANALYST=auto`.

Auto storage is used only when the credential and `CUTTLELY_POSTGRES_URL` are both unset. A selected credential still wins when it names a different database than the variable.

Pointing either URL at the application database stops the node:

> PostgreSQL MCP cannot use the application database. Point CUTTLELY_POSTGRES_URL or the Postgres URL credential at a separate database.

The rest of the app still starts.

## Fail closed

If the application user cannot create roles, analyst mode stops. It does not connect as that user. `GET /api/v1/ping` still returns `pong`.

Refresh **Available Actions** on the PostgreSQL MCP node. The list says **No Available Actions**. The description is:

> Analyst mode needs the application database user to create roles. This database refused that. Set CUTTLELY_POSTGRES_URL to a separate database, or select a Postgres URL credential. The analyst does not use the application login.

The fix is a separate database. Set `CUTTLELY_POSTGRES_URL` to it, or select a Postgres URL credential. Do not paste the application database. On Render, the Blueprint does not set that variable. [Analyst database](./render.md#analyst-database). If that host requires TLS, put `sslmode` on the URL yourself. Cuttlely does not add it.

![The PostgreSQL MCP card in the dark theme. Connect Credential says no credential is saved for this node yet. Available Actions is No Available Actions. The note under it reads: Analyst mode needs the application database user to create roles. This database refused that. Set CUTTLELY_POSTGRES_URL to a separate database, or select a Postgres URL credential. The analyst does not use the application login. Below it, Tables and views reads Isolated analyst storage: the analyst keeps its own tables here, so there is nothing to pick.](../images/analyst/available-actions-create-roles.png)

Two other stops use the same fallback, a separate URL, and do not use the application login:

> Analyst mode could not isolate the analyst role from application tables. Set CUTTLELY_POSTGRES_URL to a separate database, or select a Postgres URL credential. The analyst does not use the application login.

> Analyst mode could not read the stored role secret. The credential encryption key may have changed. Set CUTTLELY_POSTGRES_URL to a separate database instead of using the application login.

The second one is `analyst-role.enc` unreadable, or the credential key no longer decrypts it. A new key does not recover the old role password.

## Passwords in URLs

Percent-encode reserved characters in a URL password (`!`, `@`, `#`, `%`, `+`, and the others). A password left raw is refused, because Cuttlely cannot check that URL against the application database:

> PostgreSQL MCP refused a database URL it could not check against the application database.

Encode the password, restart, and select **QUERY** again.

## Troubleshooting

**Harness name is not valid.** Save `chief-of-staff`, not the template title. The id is a letter, then letters, numbers, `_`, or `-`.

**The node runs nothing.** Select **QUERY** under **Available Actions** and save. An empty action list means the `query` tool is filtered out.

**Cuttlely refused this query: it reads ..., which this node's table selection does not include.** The statement reads a relation that is not ticked on the node. Tick it, or point the analyst at a ticked view that covers it. [Pick the tables and views the analyst sees](#pick-the-tables-and-views-the-analyst-sees).

**Every query is refused with could not check this query against the table selection.** The credential's login cannot create a temporary view: it is a read replica, or `TEMP` was revoked. Use the primary, grant `TEMP`, or clear the selection. [How the selection is enforced](#how-the-selection-is-enforced).

**Tables and views says Could not list tables and views.** The node could not reach the database with that credential. The description under it is the database error, with the password removed. Fix the URL and select the refresh button.

**Create or insert fails, and the action says read-only.** `CUTTLELY_POSTGRES_URL` or a Postgres URL credential is set. That path is `Run a read-only SQL query`. Unset both to use auto storage, or point them at a database you only want to read.

**No Available Actions, and the description is the create-roles sentence.** The application user cannot create roles. Use a separate database. [Fail closed](#fail-closed).

**PostgreSQL MCP cannot use the application database.** The credential or `CUTTLELY_POSTGRES_URL` names the same database as `DATABASE_*`. Point it somewhere else.

**PostgreSQL MCP refused a database URL it could not check.** Percent-encode the password. [Passwords in URLs](#passwords-in-urls).

**canceling statement due to statement timeout.** The statement ran longer than the query timeout (15 seconds unless you changed it). Shorten it, or raise **Query timeout** under **Admin** > **Server Settings** > **Analyst**. Postgres and SQLite both apply this timeout. [Row cap and query timeout](#row-cap-and-query-timeout).

**permission denied for schema public.** This is Postgres. The analyst login cannot read application tables. Query schema `analyst`.

**relation "user" does not exist.** An unqualified name looks in `analyst` only. `public."user"` is the application table, and that schema denies the analyst login.

**Harness "chief-of-staff" cannot run: Hermes did not accept POST /v1/runs.** The agent runtime was not listening yet, or it exited after start. It binds `127.0.0.1` port `8642`. `scripts/start-cuttlely.sh` starts Cuttlely first and starts the agent runtime only after the harness gateway answers on `127.0.0.1` port `43118` (`CUTTLELY_HARNESS_GATEWAY_PORT`). Docker and Render use that same script. If the agent runtime exits, the script restarts it with backoff, up to `CUTTLELY_HERMES_MAX_RESTARTS` (default 5), and logs each restart with that process's exit status. `GET /api/v1/ping` still returns `pong` while the agent runtime is `up`, `degraded`, or `restarting`. The `X-Cuttlely-Hermes` header is that state. For `CUTTLELY_HERMES_HEALTH_GRACE` seconds after each start (default 60), a missed `/health` check does not count, so the warm-up does not restart the agent runtime. After that, one miss is `degraded` and does not count as a restart. The next successful check returns the header to `up`. Each check waits about 2 seconds. A restart waits until misses have lasted `CUTTLELY_HERMES_HEALTH_WINDOW` seconds (default 15) and the count has reached `CUTTLELY_HERMES_HEALTH_FAILS` (default 3). A harness run that is still streaming from the agent runtime is not restarted unless that process has exited. After the restart limit, ping returns HTTP 503 and the body `hermes down`. Cuttlely on port 43117 stays up either way. Wait until the header is `up`, then send the prompt again. Rows already written are still there. A watchdog line `event loop missed 3 consecutive liveness probes` with exit 75 is that exit. It showed up once under heavy load.

**The canvas chat says this harness cannot chat yet, but Try it works.** The stored edges may still use handle ids from before the type suffix. Reload the canvas. The chat check accepts both the old id and the repaired id. Saving stores the repaired ids.

**The xAI Grok chat model on Harness Prime needs a credential. Select one on that node and save the harness.** The sample model is still connected and has no key. Delete it, add **OpenAI**, select the credential, and save. The label in that sentence is the chat-model node you left on Harness Prime. [Harnesses](./harnesses.md).

**The answer is a few words and the rows are missing.** Open the analyst row on the run card and select the query chip that says `· N rows`. It shows the row count and a short preview. Read the answer for the rest of that page, and for the page line after them, such as `rows 1-100 of N (page 1 of 2, say "show more" for the next page)`. Getting the next page is [Paging through large results](#paging-through-large-results). A change such as a create or a drop is a short sentence, not raw tool JSON. The agent runtime profile `state.db` for that specialist also has the tool text.

**Harness Prime answered directly, and the answer is about the database.** A SQL statement, the words "analyst database", or a message that starts with `Analyst:` has to go to the analyst. Prime does not answer those. Send the prompt again. The run should name the analyst, not "answered directly".

**The canvas chat says `init is not a function`.** The harness canvas chat and **Try it** must use the internal prediction route, not build the canvas as a chatflow. Reload the canvas. One Enter sends one message. The field stays disabled until that reply finishes.

**The chat says the analyst tool is unavailable.** The agent runtime registered no analyst query tool. That happens when it lists tools before the harness gateway is up. `X-Cuttlely-Analyst` on `GET /api/v1/ping` is `missing` when the bridge recorded 0 tools, `ready` when it recorded at least one, and `unknown` when that status file has not been written. **Available Actions** says **Analyst tool unavailable** when the header is `missing`. Wait a few seconds and send the prompt again. The agent runtime retries the tool list. If the header stays `missing`, restart Cuttlely. The start script waits for the gateway before it starts the agent runtime.

**The chat says the analyst did not run the query.** The query tool was registered, and the specialist still answered a database question without calling it, including after one retry. That text is not a database result. The Runs chip is completed with errors. Send the prompt again. Specialist text from that skipped attempt is not streamed.

**MCP server 'analyst' rejected the last 3 calls.** That pause is for a transport or server failure, and it applies to the chat that hit the failures. A refusal (`Analyst mode refused`) and an ordinary SQL error (`no such table`, a syntax error) do not pause the tool. Send the query again in that chat after the pause, or use another chat.

**The Runs chip says completed with errors.** The run finished, and a specialist tool returned a database error or `Analyst mode refused` that the answer reports, or the chat says the analyst did not run the query, or the analyst tool is unavailable. **failed** is a run that crashed. **succeeded** means the specialist tools finished, including a `tool_call` chip that says **retried**.

**Connect Credential says no credential is saved, and queries still work.** That is auto mode. The line should read `Auto mode: isolated analyst store, no credential needed`. The warning stays when a Postgres URL is configured and no credential is saved.

**analyst.db never appears.** `CUTTLELY_ANALYST` is not `auto`, QUERY is not selected, or a Postgres URL is set so auto storage is not used. On Postgres the store is schema `analyst`, not a file.

**Analyst mode refused to open the application SQLite file.** The tool will not open `database.sqlite`. Leave it on `analyst.db`.

**Analyst mode could not read the credential encryption key.** `encryption.key` under `SECRETKEY_PATH` is missing or unreadable. **Analyst mode could not store the credential encryption key.** Cuttlely could not write that file. [From source](./from-source.md#where-your-data-lives) says where that directory is. Do not replace the key if you still need the credentials it already encrypted.
