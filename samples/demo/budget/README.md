# Budget demo database

A small, made-up company budget for PostgreSQL: four departments, planned budget lines for fiscal 2026, ten expenses with vendors, a headcount plan and a `budget_vs_actual` view. The company, departments, vendors and numbers are all invented.

It is the second database in the two-analyst [real-model check](../../../docs/how-to/analyst.md#real-model-check). The first is the [bakery demo database](../bakery/bakery-postgres.sql).

## Load it

```bash
createdb budget
psql -d budget -f samples/demo/budget/budget-postgres.sql
```

## Run the check

The check calls the OpenAI chat API, so set `OPENAI_API_KEY` and use it only on made-up data like this.

```bash
createdb bakery
psql -d bakery -f samples/demo/bakery/bakery-postgres.sql
CUTTLELY_BAKERY_URL=postgresql://127.0.0.1:5432/bakery \
CUTTLELY_BUDGET_URL=postgresql://127.0.0.1:5432/budget \
    node scripts/analyst-real-model-check.mjs two-analyst
```

A URL without a login uses `PGUSER` and `PGPASSWORD` from the environment. `bakery` instead of `two-analyst` runs the single-analyst check on the bakery database alone.

The script asks nine questions. The routing prompt picks the analyst for each, as Harness Prime does, and the script checks the answer for the expected figure. It prints JSON with each answer, the SQL the analyst ran, seconds per question and prompt tokens, and exits 1 when a check fails.

| Question                                                               | Analyst | Expected                               |
| ---------------------------------------------------------------------- | ------- | -------------------------------------- |
| What are the top 3 products by revenue?                                | Bakery  | Sourdough Loaf, Seeded Rye, Lemon Tart |
| Which wholesale account owes us the most right now, and how much?      | Bakery  | Hilltop Deli, $600.12                  |
| Which store had the most revenue in the most recent week?              | Bakery  | Old Town, $5,976.50                    |
| Which department has used the largest share of its 2026 budget so far? | Budget  | Engineering                            |
| Which vendor have we paid the most, and how much?                      | Budget  | SkyCloud, $215,000                     |
| What is the total planned budget for fiscal 2026?                      | Budget  | $625,000                               |
| How much did we spend on software this year?                           | Budget  | $26,000                                |
| Analyst: what were total sales in June 2026?                           | Bakery  | $49,557.50                             |
| Analyst: list the tables you can see.                                  | Both    | Each lists its tables                  |
