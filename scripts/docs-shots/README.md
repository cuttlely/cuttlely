# Docs screenshots

`versioning-evaluations.mjs` reshoots the pictures in `docs/images/versioning` and `docs/images/evaluations`.

It starts its own servers on empty data directories, signs in as the local owner, and captures the app in the light theme. Chat answers come from an in-process stand-in (`fake-model.cjs`) so the script does not call a model provider. The GitHub card uses the local stand-in described in `docs/reference/versioning-settings.md` (`CUTTLELY_GITHUB_ALLOW_FILE_REMOTES`, `CUTTLELY_GITHUB_TEST_ROOT`, `CUTTLELY_GITHUB_TEST_API`) and a bare repository on this machine. Nothing signs in to an outside service.

The servers must already be built (`pnpm build`). Then:

```bash
node scripts/docs-shots/versioning-evaluations.mjs
```

`DOCS_SHOTS_ONLY=canvas-last-edited,history-drawer` captures a subset. The script prints no passwords, tokens, or model keys.
