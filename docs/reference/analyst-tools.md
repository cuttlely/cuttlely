# Analyst tools

The tools the **PostgreSQL MCP** node gives an analyst specialist, the node fields that shape them, and the refusals they return. The guide is [Analyst mode](../how-to/analyst.md).

## Node fields

| Field                       | Input name              | Stored as                                      | Notes                                                                                                                                                                                          |
| --------------------------- | ----------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect Credential**      | `credential`            | Credential id                                  | A `PostgresUrl` credential. It wins over `CUTTLELY_POSTGRES_URL`. Without either, `CUTTLELY_ANALYST=auto` uses isolated storage. [Which setting wins](../how-to/analyst.md#which-setting-wins) |
| **Available Actions**       | `mcpActions`            | JSON array, such as `["query"]`                | Without `query` the node offers no tool. `describe` comes with `query` when a selection is set                                                                                                 |
| **Tables and views**        | `analystRelations`      | JSON array of schema-qualified names, or empty | Checkbox list from the `listRelations` load method. Empty keeps every readable table. Only for a database connected by URL                                                                     |
| **Row cap**                 | `analystRowCap`         | Number                                         | Lower than the server row cap only                                                                                                                                                             |
| **Query timeout (seconds)** | `analystTimeoutSeconds` | Number                                         | Shorter than the server query timeout only                                                                                                                                                     |

`listRelations` returns one option per table, partitioned table, foreign table, view and materialized view that the login can `SELECT`, outside `pg_catalog`, `information_schema` and other `pg_` schemas, partitions left out, at most 2,000. Materialized views come first, then views, then tables, each sorted by schema and name. An option's `name` and `label` are the schema-qualified name with identifiers quoted where Postgres needs it (`public.stores`, `"Sales 2026".daily`). Its `description` is the kind, the column count and the comment, joined with `·`. A message, such as **Isolated analyst storage** or **Could not list tables and views**, is an option named `error`.

## query

| Argument                      | Type    | Notes                                                                       |
| ----------------------------- | ------- | --------------------------------------------------------------------------- |
| `sql`, `statement` or `query` | string  | One statement                                                               |
| `cursor`                      | string  | Page cursor from a capped result. Repeats that statement                    |
| `page`                        | integer | The next page, or 1. A stable page number only when the page line names one |

The result is JSON with `rows`, `truncated`, and on a capped result `summary` (the page line) and `cursor`. Paging is in [Paging through large results](../how-to/analyst.md#paging-through-large-results).

With a selection set, the description ends with `Only these relations can be queried.` and one line per selected relation that still exists, in the list order:

```text
- <name> (<kind>, <n> columns): <comment, cut at 120 characters>
```

A relation with no comment has no colon part. When the database does not answer while the tools are listed, each line is the name alone, and the check still applies to every call.

## describe

Offered only when **Tables and views** has at least one name.

| Argument                                  | Type   | Notes                                                                            |
| ----------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `name` (also `relation`, `table`, `view`) | string | A selected name, with or without the schema. A bare name must match one relation |

| Field           | Present                         | Value                                                                                                                                                                                        |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | always                          | Schema-qualified name                                                                                                                                                                        |
| `kind`          | always                          | `table`, `foreign table`, `view` or `materialized view`                                                                                                                                      |
| `comment`       | when the relation has one       | The relation comment                                                                                                                                                                         |
| `columns`       | always                          | `<column> <type>[ not null][ -- <comment>]`, in column order                                                                                                                                 |
| `primaryKey`    | when there is one               | Column names                                                                                                                                                                                 |
| `relationships` | when any involve selected names | `<from>(<columns>) -> <to>(<columns>)` for a foreign key between selected relations, `reads <name>` for a selected relation a view reads, `read by <name>` for a selected view that reads it |
| `definition`    | views and materialized views    | `pg_get_viewdef`, cut at 4,000 characters                                                                                                                                                    |

Catalog reads for `describe` run in a read-only transaction with the node's query timeout.

## Refusals

Each is returned as `{ "error": "...", "cuttlelyOutcome": "expected" }`. An expected result does not pause the analyst tool.

| When                                                                              | Text starts with                                                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A selection is set and the statement is not `SELECT`, `WITH`, `VALUES` or `TABLE` | `This node limits the analyst to selected tables and views, so it runs only SELECT, WITH, VALUES and TABLE queries.`    |
| The statement reads a relation that is not selected                               | `Cuttlely refused this query: it reads <names>, which this node's table selection does not include. Selected: <names>.` |
| It calls a function or operator outside `pg_catalog`                              | `Cuttlely refused this query: function <schema.name> is not built in.` (or `operator`)                                  |
| It calls a built-in that can reach other data or change name resolution           | `Cuttlely refused this query: <name> is not allowed while a table selection is set.`                                    |
| The login cannot create a temporary view                                          | `Cuttlely could not check this query against the table selection:`                                                      |
| No selected name exists any more                                                  | `None of the selected tables or views exist any more.`                                                                  |
| `describe` names a relation that is not selected                                  | `<name> is not one of the selected tables or views. Choose one of:`                                                     |

The built-ins refused while a selection is set are the `query_to_xml`, `table_to_xml`, `cursor_to_xml`, `schema_to_xml` and `database_to_xml` families, `ts_stat`, `ts_rewrite`, `currtid2`, `loread`, `set_config`, `pg_sequence_last_value`, `pg_get_viewdef`, `pg_get_ruledef`, `pg_get_functiondef`, `pg_get_triggerdef`, and any name starting with `lo_`, `pg_read_`, `pg_ls_`, `pg_stat_file` or `dblink`. The check itself is [How the selection is enforced](../how-to/analyst.md#how-the-selection-is-enforced). The source is `packages/harness/runtime/analyst-relations.mjs`.
