# Docs screenshots

Reshoots the pictures for the canvas, share and embed, the API and Try the demo.

```bash
pnpm build
bash scripts/setup-hermes.sh
node scripts/docs-shots/capture.mjs
```

The script starts a fresh server on an empty data directory, signs in with the local owner account, and takes the pictures with Playwright at browser zoom 100%. It does not sign in to an outside service.

Set `DOCS_SHOT_USE_EXTERNAL=1` and `OPENAI_API_KEY` to answer with that key. With the variable unset, a loopback stand-in answers so the pictures stay on made-up bakery and customer-care text and do not show a currency amount. The key is read from the environment only. The script never prints it, and no picture shows a key, a token or a masked prefix.

`DOCS_SHOTS=canvas,share,api,demo,demo-chart,card` limits the set. `demo-chart` reshoots only the bakery March croissant answer. `all` is the default.

## Knowledge pipelines and Usage

`capture-etl-usage.mjs` reshoots the pictures in `docs/images/etl/` and `docs/images/usage/`.

```bash
pnpm build
node scripts/docs-shots/capture-etl-usage.mjs
```

The server has to be built first (`packages/server/dist`). The script starts a local server on an empty data directory, signs in as the local owner, and drives the pages with Playwright. A picture name on the command line reshoots only that file. Pipeline drawer pictures grow the viewport until the whole drawer, including its right edge, is in the frame. It does not sign in to an outside service. Chat replies come from `fake-chat.cjs`, which reads `DOCS_SHOT_CATALOG`. The capture script sets that to the sample catalog path.
