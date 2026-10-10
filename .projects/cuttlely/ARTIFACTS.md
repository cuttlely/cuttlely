# Artifacts

Where things live. Merged work is in `git log` and the closed pull requests (`gh pr list -R cuttlely/cuttlely --state merged`); open work is in the [issues](https://github.com/cuttlely/cuttlely/issues). This file does not copy either list.

## Docs

| What                                 | Where                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product README and first ten minutes | `README.md`; translated READMEs in `i18n/`                                                                                                         |
| Docs index                           | `docs/README.md`                                                                                                                                   |
| User guides                          | `docs/how-to/` (harnesses, analyst, ETL, canvas, versioning, share and embed, try the demo, server settings, sign-in, Docker, from source, Render) |
| API guide and example app            | `docs/api.md`, `examples/web-app/`                                                                                                                 |
| Reference                            | `docs/reference/` (override config, versioning settings and APIs, version files, model list, agent runtime upgrades)                               |
| Identity                             | `docs/identity/` (AuthKit setup and identity behaviour)                                                                                            |
| Import from other tools              | `docs/bring-your-flows.md` and the import guides it links                                                                                          |
| Releases and upgrades                | `docs/releases.md`, `docs/upgrading.md`, `CHANGELOG.md`                                                                                            |
| Security and outbound connections    | `SECURITY.md` (including "What Cuttlely connects to")                                                                                              |
| Credits and licenses                 | `CREDITS.md`, `NOTICE`, `LICENSE.md`                                                                                                               |
| Contributor guide and agent rules    | `CONTRIBUTING.md`, `AGENTS.md`, `.cursor/rules/`, `.cursor/skills/`                                                                                |
| Screenshots                          | `docs/images/` (taken from a running server with made-up data)                                                                                     |
| Website                              | `website/` (source); the pages come from `docs/` at build time                                                                                     |
| Brand assets                         | `assets/brand/`                                                                                                                                    |

## Code artifacts

| What                                   | Where                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Sample harnesses, chatflows, pipelines | `samples/harnesses/`, `samples/chatflows/`, `samples/etl/`, `samples/demo/`                              |
| Node catalog classification            | `packages/components/nodes/module-catalog.json` (`scripts/build-module-catalog.mjs`)                     |
| Chat-model list                        | `packages/components/models.json`                                                                        |
| Server settings registry               | `packages/server/src/settings/registry.ts`                                                               |
| Upgrade fixture                        | `scripts/fixtures/upgrade/` (`scripts/upgrade-fixture.mjs`)                                              |
| Identity schema fixtures and golden    | `scripts/fixtures/`, `scripts/identity-schema.golden.json`                                               |
| Agent runtime vendor inputs            | `hermes/UPSTREAM_COMMIT`, `hermes/CUTTLELY_EXCLUDE.txt`, `hermes/patches/`, `hermes/CUTTLELY_VENDOR.txt` |
| Repository description                 | `.github/repo-description.txt`                                                                           |

## Generated locally (gitignored)

| What                       | Where                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| Verify report              | `.verify/verify-report.json`, `.verify/verify-summary.md`              |
| App data from a source run | `.cuttlely/` (records, queue, runtime home, ETL data, version history) |
| Nodes manifest             | `packages/components/dist/nodes-manifest.json`                         |
