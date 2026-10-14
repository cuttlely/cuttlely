# Docs screenshots

Two scripts. Neither signs in to an outside service. A model key is read from the environment only, and neither script prints it.

## Canvas, share, API and Try the demo

```bash
pnpm build
bash scripts/setup-hermes.sh
node scripts/docs-shots/capture.mjs
```

The script starts a fresh server on an empty data directory, signs in with the local owner account, and takes the pictures with Playwright at browser zoom 100%.

Set `DOCS_SHOT_USE_EXTERNAL=1` and `OPENAI_API_KEY` to answer with that key. With the variable unset, a loopback stand-in answers so the pictures stay on made-up bakery and customer-care text and do not show a currency amount. No picture shows a key, a token or a masked prefix.

`DOCS_SHOTS=canvas,share,api,demo,demo-chart,card` limits the set. `demo-chart` reshoots only the bakery March croissant answer. `all` is the default.

## Harnesses and Analyst

```bash
node scripts/docs-shots/reshoot-harnesses-analyst.mjs
```

This reshoots `docs/images/harnesses/` and `docs/images/analyst/`. When `OPENAI_API_KEY` is unset, `model-stand-in.mjs` answers chat completions on `127.0.0.1` and the server is pointed at it with `OPENAI_BASE_URL`.

`bakery-mcp.mjs` is the local MCP server for the SQL-refusal picture. It speaks stdio and does not open a database.

The server uses a new data directory under `/tmp/docs-shots`. Sample names are the bakery ones already in the guides. Light theme, violet accent, zoom 100%.

Postgres pictures need a local Postgres the current user can reach with `sudo -u postgres psql`. The script creates a throwaway login and database for that run.

`DOCS_SHOTS_FROM=<step>` restarts at one step (`empty`, `templates`, `analyst`, `paging`, `trace`, `workspaces`, `postgres`, and the others named in the script).
