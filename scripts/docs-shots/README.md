# Guide screenshots

`capture-etl-usage.mjs` reshoots the knowledge-pipeline and Usage pictures in `docs/images/etl/` and `docs/images/usage/`.

It starts a local server on an empty data directory, signs in as the local owner, and drives the pages with Playwright at a fixed viewport. Chat replies come from `fake-chat.cjs` in this folder. The script does not sign in to an outside service and does not read a model key.

```bash
pnpm build
node scripts/docs-shots/capture-etl-usage.mjs
```

The server has to be built first (`packages/server/dist`). The first run downloads Playwright's Chromium if it is not already installed.
