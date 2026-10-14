# Docs screenshots

`reshoot-harnesses-analyst.mjs` reshoots the pictures in `docs/images/harnesses/` and `docs/images/analyst/` from a local server. It does not call a model provider and it does not sign in to an outside account.

From the repo root, on Node 24:

```bash
node scripts/docs-shots/reshoot-harnesses-analyst.mjs
```

When `OPENAI_API_KEY` is unset, `model-stand-in.mjs` answers chat completions on `127.0.0.1`. The server is pointed at it with `OPENAI_BASE_URL`. A key in the environment is used instead, and only by that name: the script never prints it.

`bakery-mcp.mjs` is the local MCP server for the SQL-refusal picture. It speaks stdio and does not open a database.

The server uses a new data directory under `/tmp/docs-shots`. Sample names are the bakery ones already in the guides. Light theme, violet accent, zoom 100%.

Postgres pictures need a local Postgres the current user can reach with `sudo -u postgres psql`. The script creates a throwaway login and database for that run.

`DOCS_SHOTS_FROM=<step>` restarts at one step (`empty`, `templates`, `analyst`, `paging`, `trace`, `workspaces`, `postgres`, and the others named in the script).
