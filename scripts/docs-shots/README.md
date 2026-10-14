# Docs screenshots

Two captures. Each starts a fresh server on an empty data directory, signs in with the local owner account, and takes pictures with Playwright at browser zoom 100%. Neither signs in to an outside service. The server must already be built (`pnpm build`).

## Canvas, share and embed, the API, and Try the demo

```bash
pnpm build
bash scripts/setup-hermes.sh
node scripts/docs-shots/capture.mjs
```

Set `DOCS_SHOT_USE_EXTERNAL=1` and `OPENAI_API_KEY` to answer with that key. With the variable unset, a loopback stand-in answers so the pictures stay on made-up bakery and customer-care text and do not show a currency amount. The key is read from the environment only. The script never prints it, and no picture shows a key, a token, or a masked prefix.

`DOCS_SHOTS=canvas,share,api,demo,demo-chart,card` limits the set. `demo-chart` reshoots only the bakery March croissant answer. `all` is the default.

## Version history, the Publish check, and evaluations

```bash
node scripts/docs-shots/versioning-evaluations.mjs
```

Chat answers come from an in-process stand-in (`fake-model.cjs`) so the script does not call a model provider. The GitHub card uses the local stand-in in `docs/reference/versioning-settings.md` (`CUTTLELY_GITHUB_ALLOW_FILE_REMOTES`, `CUTTLELY_GITHUB_TEST_ROOT`, `CUTTLELY_GITHUB_TEST_API`) and a bare repository on this machine. After a dialog, popover, toast, or collapse opens, the script waits until that element is visible and its transition has finished, then takes the picture.

`DOCS_SHOTS_ONLY=canvas-last-edited,history-drawer` captures a subset. The script prints no passwords, tokens, or model keys.
