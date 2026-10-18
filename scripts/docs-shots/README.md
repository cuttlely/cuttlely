# Docs screenshots

This directory is listed in `.dockerignore`. It is not part of the runtime image, and it is not in any published npm package. The scripts do not sign in to an outside service.

## Canvas, share, API and Try the demo

```bash
pnpm build
bash scripts/setup-hermes.sh
node scripts/docs-shots/capture.mjs
```

The script starts a fresh server on an empty data directory, signs in with the local owner account, and takes the pictures with Playwright at browser zoom 100%.

Set `DOCS_SHOT_USE_EXTERNAL=1` and `OPENAI_API_KEY` to answer with that key. With the variable unset, a loopback stand-in (`stub-model.mjs`) answers so the pictures stay on made-up bakery and customer-care text. Its customer-care decisions state the sample policy's amounts, and the March croissant answer draws a bar chart. The key is read from the environment only. The script never prints it, and no picture shows a key, a token or a masked prefix.

Amounts are masked in `money.mjs` before each picture, and `money.test.mjs` (run by `pnpm verify`) covers it. `try-the-demo/try-the-demo-key.png`, a crop of the Try the demo card, is not masked. It only gets the Estimated cost check and the money check, and fails on either.

-   Every frame: the phrase `Estimated cost` is removed up to the end of its sentence or its text. When nothing with a digit follows the phrase in its text, a `$` amount at the start of the next text is removed too, including one after `≈`, `~`, `about` or `approx`, and a text holding only that lead-in is removed with it. The bare word `estimated` does not count as the label. The frame fails without being saved if a `$` amount is still in the first sentence of that next text, or if `Estimated cost` is still visible on the page.
-   `try-the-demo/customer-care-*` frames keep every other `$` amount, such as the shipping refund and the store credit. Answer text such as `estimated $279.00 value` is left as written.
-   Every other frame also has, in any text that holds a `$` amount, the word `estimated` with the amount after it and every other `$` amount removed. It fails if a `$` figure or a number with two decimals is still shown.

Before the policy, carrier, held-orders and croissant pictures, the script waits 3 seconds, then until the page text has not changed across five one-second checks in a row and the page shows no Running, Answering or Waiting for the first token. It then checks the answer: `Larkfield` after Maya Okafor's question for policy, `road closure for snow` after Daniel Reyes's question for carrier, `LH-20409` after the held-orders question for held, and `Riverside sold 335 more` anywhere in the chat for croissant. The frame fails without being saved if the chat is still changing after 240 seconds, if the question or the text is missing, or if the held-orders chat cannot be scrolled to its question.

`DOCS_SHOTS=canvas,share,api,demo,demo-chart,card` limits the set. `demo-chart` reshoots only the bakery March croissant answer. `all` is the default.

## Theme

A frame whose main subject is the canvas editor is taken in the app's dark theme. In `capture.mjs` and `reshoot-harnesses-analyst.mjs` a large dialog or the expanded chat over a canvas, and a crop of only the chat panel, stay light, and each script lists its dark frames in a `DARK` set. The two opening Try the demo chats (`customer-care-open.png` and `demo-open.png`) are dark, and their starter questions wrap so none is cut off. `capture-etl-usage.mjs`, `versioning-evaluations.mjs`, and `capture-settings.mjs` take any frame with a canvas on screen in the dark theme, including a drawer or dialog over it (and, in `versioning-evaluations.mjs`, the read-only version page). Admin, settings, sign-in, list, and Usage pages stay light. `theme.mjs` switches the theme on the open page through the same store action as the header toggle, so a canvas reached by in-app navigation changes too, and it does not save the choice, so the next page loads light. `DOCS_SHOTS_CANVAS_THEME=light` takes every frame in the light theme.

## Server settings, sign-in, roles, source install and imports

```bash
pnpm build
node scripts/docs-shots/capture-settings.mjs
```

The script starts its own servers on empty data directories, in a headless browser at a fixed size, in the light theme. It signs in with a local owner account it creates itself. The account name, the workspace, and any sample text are made up. Pictures show no token, no real chat, and no host name. It does not read a model key. The AuthKit frames type an obviously fake key into a masked field and never print it.

`DOCS_SHOTS=testing` takes only the Testing and Limits picture. The server is started with one in-range publish-check limit set on the host so that field shows as set by the host. Host-only rows show set or not set and never a value.

`DOCS_SHOTS=local-users` takes the Users list, the sessions drawer, and the audit log. It uses local password sign-in, example.com addresses, and a one-time invite link that the script does not print. Those three frames, and the Users list in the roles set, are 1440 by 1400 so the whole Admin menu shows. The script fails if the sidebar does not show Users, Teams, Roles, Server Settings, Logs, Audit log, and Version History, in that order.

Sample files for the import frames are `examples/imports/bakery-helper.json` and `examples/imports/bakery-greeter.json`. That directory is in `.dockerignore` with this one. The image does not read those files.

## Knowledge pipelines and Usage

`capture-etl-usage.mjs` reshoots the pictures in `docs/images/etl/` and `docs/images/usage/`.

```bash
pnpm build
node scripts/docs-shots/capture-etl-usage.mjs
```

The server has to be built first (`packages/server/dist`), and the padding step needs Python with Pillow. Paths show in the pictures. `DOCS_SHOTS_DATA_DIR` sets the data folder (emptied first, laid out like the Docker volume), for example `/var/cuttlely`. Run the script from a checkout at a neutral path, such as a bind mount at `/srv/cuttlely`, so the sample and upload paths do not name your machine. The script starts a local server on an empty data directory, signs in as the local owner, and drives the pages with Playwright. A picture name on the command line reshoots only that file. Pipeline drawer pictures grow the viewport until the whole drawer, including its right edge, is in the frame. `usage-page.png` ends above the Model prices section, which `usage-prices.png` shows. It does not sign in to an outside service. Chat replies come from `fake-chat.cjs`, which reads `DOCS_SHOT_CATALOG`. The capture script sets that to the sample catalog path.

## Version history, the Publish check, and evaluations

```bash
node scripts/docs-shots/versioning-evaluations.mjs
```

Chat answers come from an in-process stand-in (`fake-model.cjs`) so the script does not call a model provider. The GitHub card uses the local stand-in in `docs/reference/versioning-settings.md` (`CUTTLELY_GITHUB_ALLOW_FILE_REMOTES`, `CUTTLELY_GITHUB_TEST_ROOT`, `CUTTLELY_GITHUB_TEST_API`) and a bare repository on this machine. After a dialog, popover, toast, or collapse opens, the script waits until that element is visible and its transition has finished, then takes the picture. The evaluation results frame also waits until its pie, bar and line charts have drawn and stopped moving, because those charts animate in JavaScript.

The Publish dialog frames are scrolled so the top of the dialog starts on a whole line.

`DOCS_SHOTS_ONLY=canvas-last-edited,history-drawer` captures a subset. The script prints no passwords, tokens, or model keys.

## Harnesses and Analyst

```bash
node scripts/docs-shots/reshoot-harnesses-analyst.mjs
```

This reshoots `docs/images/harnesses/` and `docs/images/analyst/`. The harness list is taken before Build with AI adds teams. The sqlite terminal figure prints the workspace database filename the server created. When `OPENAI_API_KEY` is unset, `model-stand-in.mjs` answers chat completions on `127.0.0.1` and the server is pointed at it with `OPENAI_BASE_URL`.

`bakery-mcp.mjs` is the local MCP server for the SQL-refusal picture. It speaks stdio and does not open a database.

The server uses a new data directory under `/tmp/docs-shots`. Sample names are the bakery ones already in the guides. Canvas frames are dark and the rest light (see Theme), violet accent, zoom 100%.

Postgres pictures need a local Postgres the current user can reach with `sudo -u postgres psql`. The script creates a throwaway login and database for that run. A second team's harness gets its own credential through the API, not a copied row.

`DOCS_SHOTS_FROM=<step>` restarts at one step (`empty`, `templates`, `analyst`, `paging`, `trace`, `workspaces`, `postgres`, and the others named in the script).

## Analyst table picker

```bash
pnpm build
bash scripts/setup-hermes.sh
PGPASSWORD=... node scripts/docs-shots/capture-analyst-picker.mjs
```

This takes `docs/images/analyst/postgres-mcp-table-picker.png` and `docs/images/analyst/postgres-mcp-rules.png` (dark, canvas frames) and `docs/images/analyst/try-it-describe-trace.png` (light). `DOCS_SHOTS=picker,rules,describe` limits the set; `picker` and `rules` do not run a model. It needs a local Postgres admin login (`CUTTLELY_TEST_PG_HOST`, `CUTTLELY_TEST_PG_PORT`, `CUTTLELY_TEST_PG_USER`, and `PGPASSWORD`). It loads `samples/demo/bakery/bakery-postgres.sql` into a new database with a read-only login, saves that as a Postgres URL credential, and builds a one-analyst harness whose PostgreSQL MCP node ticks six relations and holds the made-up bakery rules the Analyst guide quotes. Without `OPENAI_API_KEY`, `model-stand-in.mjs` answers: for the unpaid invoices question it calls describe, then query. The database and the login are dropped at the end. The question asks for a count, so no amount appears in a picture. The model is scripted, so the run card's token counts and timings are illustrative, not a measurement.
