# Docs screenshots

This directory is listed in `.dockerignore`. It is not part of the runtime image, and it is not in any published npm package. The scripts do not sign in to an outside service.

## Canvas, share, API and Try the demo

```bash
pnpm build
bash scripts/setup-hermes.sh
node scripts/docs-shots/capture.mjs
```

The script starts a fresh server on an empty data directory, signs in with the local owner account, and takes the pictures with Playwright at browser zoom 100%.

Set `DOCS_SHOT_USE_EXTERNAL=1` and `OPENAI_API_KEY` to answer with that key. With the variable unset, a loopback stand-in answers so the pictures stay on made-up bakery and customer-care text and do not show a currency amount. The key is read from the environment only. The script never prints it, and no picture shows a key, a token or a masked prefix.

`DOCS_SHOTS=canvas,share,api,demo,demo-chart,card` limits the set. `demo-chart` reshoots only the bakery March croissant answer. `all` is the default.

## Server settings, sign-in, roles, source install and imports

```bash
pnpm build
node scripts/docs-shots/capture-settings.mjs
```

The script starts its own servers on empty data directories, in a headless browser at a fixed size, in the light theme. It signs in with a local owner account it creates itself. The account name, the workspace, and any sample text are made up. Pictures show no token, no real chat, and no host name. It does not read a model key. The AuthKit frames type an obviously fake key into a masked field and never print it.

`DOCS_SHOTS=testing` takes only the Testing and Limits picture. The server is started with one in-range publish-check limit set on the host so that field shows as set by the host. Host-only rows show set or not set and never a value.

`DOCS_SHOTS=local-users` takes the Users list, the sessions drawer, and the audit log. It uses local password sign-in, example.com addresses, and a one-time invite link that the script does not print.

Sample files for the import frames are `examples/imports/bakery-helper.json` and `examples/imports/bakery-greeter.json`. That directory is in `.dockerignore` with this one. The image does not read those files.

## Knowledge pipelines and Usage

`capture-etl-usage.mjs` reshoots the pictures in `docs/images/etl/` and `docs/images/usage/`.

```bash
pnpm build
node scripts/docs-shots/capture-etl-usage.mjs
```

The server has to be built first (`packages/server/dist`). The script starts a local server on an empty data directory, signs in as the local owner, and drives the pages with Playwright. A picture name on the command line reshoots only that file. Pipeline drawer pictures grow the viewport until the whole drawer, including its right edge, is in the frame. It does not sign in to an outside service. Chat replies come from `fake-chat.cjs`, which reads `DOCS_SHOT_CATALOG`. The capture script sets that to the sample catalog path.

## Version history, the Publish check, and evaluations

```bash
node scripts/docs-shots/versioning-evaluations.mjs
```

Chat answers come from an in-process stand-in (`fake-model.cjs`) so the script does not call a model provider. The GitHub card uses the local stand-in in `docs/reference/versioning-settings.md` (`CUTTLELY_GITHUB_ALLOW_FILE_REMOTES`, `CUTTLELY_GITHUB_TEST_ROOT`, `CUTTLELY_GITHUB_TEST_API`) and a bare repository on this machine. After a dialog, popover, toast, or collapse opens, the script waits until that element is visible and its transition has finished, then takes the picture.

`DOCS_SHOTS_ONLY=canvas-last-edited,history-drawer` captures a subset. The script prints no passwords, tokens, or model keys.

## Harnesses and Analyst

```bash
node scripts/docs-shots/reshoot-harnesses-analyst.mjs
```

This reshoots `docs/images/harnesses/` and `docs/images/analyst/`. The harness list is taken before Build with AI adds teams. The sqlite terminal figure prints the workspace database filename the server created. When `OPENAI_API_KEY` is unset, `model-stand-in.mjs` answers chat completions on `127.0.0.1` and the server is pointed at it with `OPENAI_BASE_URL`.

`bakery-mcp.mjs` is the local MCP server for the SQL-refusal picture. It speaks stdio and does not open a database.

The server uses a new data directory under `/tmp/docs-shots`. Sample names are the bakery ones already in the guides. Light theme, violet accent, zoom 100%.

Postgres pictures need a local Postgres the current user can reach with `sudo -u postgres psql`. The script creates a throwaway login and database for that run.

`DOCS_SHOTS_FROM=<step>` restarts at one step (`empty`, `templates`, `analyst`, `paging`, `trace`, `workspaces`, `postgres`, and the others named in the script).
