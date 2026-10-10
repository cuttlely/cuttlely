# Runbook

Contributor and maintainer commands. People installing Cuttlely use the root README, `docs/how-to/docker.md`, `docs/how-to/from-source.md`, `docs/how-to/render.md` and `docs/how-to/sign-in.md`. Commands here come from the root `package.json`, `packages/*/package.json` and `scripts/`.

## Working on a change

```bash
git fetch origin
git switch -c <short-topic> origin/main     # or a separate worktree per change: git worktree add -b <topic> ../cuttlely-<topic> origin/main
pnpm install --frozen-lockfile
pnpm --filter flowise-components build      # a fresh checkout needs it before `pnpm verify --fast` and the pre-push hook pass
```

-   One concern per pull request, against `main`. Commit messages are one plain sentence describing the user-visible change, then a short body.
-   **Gate (D27).** A docs-only change runs `pnpm --filter flowise-components build && pnpm verify --fast`. Anything else runs the full `pnpm verify` on the exact head you will merge. If the head moves, run it again.
-   **Keep up with `main`.** If `main` moved while your pull request was open, merge `origin/main` into your branch and re-run the gate. Do not rewrite a pushed branch and do not force-push.
-   **Merge.** Squash-merge, pinned to the head you verified: `gh pr merge <n> --squash --match-head-commit <sha>`.
-   **Hooks stay on.** Do not use `git push --no-verify`. `CUTTLELY_SKIP_VERIFY=1` and `CUTTLELY_SKIP_HANDOFF_CHECK=1` exist for emergencies and never replace the gate.
-   **Project notes.** A code change updates `.projects/cuttlely/` in the same pull request. Run the `refresh-project-handoff` skill once before the push.
-   **One heavy job at a time.** On a shared or small machine, run full verifies, builds, live servers and Docker checks one after another. Parallel runs push the load up until timing tests (`rateLimit`, `clientAbort`, flow versions, promote) time out or Jest workers are killed; those are not code failures. Re-run once on a quiet machine before you debug.
-   **Issues.** Write them so a stranger can act on them: the symptom, how to reproduce, the expected result. No machine paths, secrets or customer data, and no exploit details for a security problem (use private vulnerability reporting instead; see `SECURITY.md`).

## Toolchain

| Tool   | Version                                         | Notes                                                                                                             |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Node   | `.nvmrc` (v24); `engines.node` is `^24`         | `pnpm verify` and the harness credential reader need `node:sqlite`, so use Node 24                                |
| pnpm   | `packageManager` pins the version Corepack runs | If Corepack cannot write its default folder on your machine, set `COREPACK_HOME` to a writable directory          |
| Python | 3.11 to 3.14. `hermes/uv.lock` covers 3.14 only | `bash scripts/setup-hermes.sh [version]`: 3.14 uses the lock; 3.11 to 3.13 resolve the same requirements unfrozen |
| uv     | any recent                                      | Creates the agent runtime's virtualenv                                                                            |
| Docker | Compose 2.x                                     | Only for the Docker install and `scripts/docker-smoke.sh`                                                         |

Commits need a git identity (`user.name` and `user.email`). On a machine without a global identity, set it per repository or with `GIT_AUTHOR_*` and `GIT_COMMITTER_*`.

## Install and offline checks

```bash
pnpm install
node harness/check.mjs        # offline harness checks: no build, no key, no network (pnpm harness:check)
node etl/check.mjs            # offline ETL checks; the retriever and splitter cases need the components build (pnpm etl:check)
node etl/check.mjs --stress   # adds a generated 1,000,000-row CSV and a 401-file repository; several minutes
```

`harness/check.mjs` loads `crypto-js` through `packages/server`, so it needs `pnpm install`. It uses mocked agent runtime and model calls and a temporary `CUTTLELY_DATA_DIR`. One case runs the built Calculator node and prints `skip` when components are not built.

## Local verify

```bash
pnpm verify                   # the full gate; `pnpm verify --help` lists the 22 steps
pnpm verify --fast            # lint, typecheck, verify-test, website-docs, chat-widget, unit, server-settings-ui, handoff-test, render-blueprint, identity-migration
pnpm verify --skip smoke      # skip one step locally; repeat --skip for more. Not for the merge gate
pnpm verify:comment           # prints the summary for a pull request comment
CUTTLELY_VERIFY_JEST_WORKERS=4 pnpm verify   # unit Jest workers; default 50%
```

The report is `.verify/verify-report.json` and `.verify/verify-summary.md` (gitignored). `--fast` does not build, so the server unit tests need a `packages/` build on disk from an earlier full verify or `pnpm build`.

The identity schema compare runs on every full verify. SQLite always runs. Postgres runs when `PGPASSWORD` is set; MariaDB when `MYSQL_PWD` or `CUTTLELY_TEST_MYSQL_PASSWORD` is set (`CUTTLELY_TEST_MARIADB_PORT`, default 3306); MySQL 8 when `CUTTLELY_TEST_MYSQL8_PORT` (default 3307) accepts that password or `CUTTLELY_TEST_MYSQL8_PASSWORD`. A missing server is a skip, not a pass.

The pre-push hook runs the handoff check, then `pnpm verify --fast`, then `node scripts/scan-secrets.mjs`. The handoff check rejects a push whose commits since `origin/main` change code without touching `.projects/cuttlely/`. Docs (`*.md`, `.projects/`) and tests (`*.test.*`, `*.spec.*`, `__tests__`, `__mocks__`, `cypress/`) pass without it.

## Build, test, lint

```bash
pnpm build                    # turbo build of every package
pnpm test                     # jest in server, components and ui
pnpm lint                     # eslint (with prettier) over js, jsx, ts, tsx, json and md; hermes/ is ignored
pnpm format                   # prettier write
pnpm --filter <pkg> test:coverage   # one package at a time on a small machine; parallel jest packages can get workers killed
```

`pnpm test:queue-abort` checks queue mode end to end against a Redis (`REDIS_URL`) and a built server, with a placeholder model and no key. `pnpm verify` does not run it; the daily scheduled CI run on `main` does. CONTRIBUTING has the full command.

`pnpm install` sets up husky; commits run `lint-staged` (eslint --fix on staged files). Formatting: 4 spaces, single quotes, no semicolons, print width 140.

## Run the one server

```bash
bash scripts/setup-hermes.sh          # once: the agent runtime's Python environment (hermes/.venv, with aiohttp and the mcp extra)
pnpm build
bash scripts/start-cuttlely.sh        # or: pnpm start:harness
```

The server listens on `PORT` (default 43117; set `HOST=0.0.0.0` for all interfaces). The agent runtime listens on `127.0.0.1:$HERMES_API_PORT` (default 8642). Wait for `Cuttlely is ready. Open http://localhost:<port>`. Data goes to `.cuttlely/` (gitignored) unless `CUTTLELY_DATA_DIR` is set.

The start script:

-   Exits early with `pnpm install && pnpm build` when the checkout is not built, and with setup steps when the chosen Python cannot import the runtime. It uses the first of `HERMES_PYTHON`, `hermes/.venv/bin/python` or `python3`.
-   Picks a Node that can load `node:sqlite` with `scripts/pick-cuttlely-node.mjs` (PATH's `node`, the `--experimental-sqlite` flag, or a Node 24 from nvm).
-   Starts the server first and the runtime only after the harness gateway answers `GET /health` on `CUTTLELY_HARNESS_GATEWAY_PORT` (default 43118, wait `CUTTLELY_GATEWAY_WAIT_SECONDS`, default 180).
-   Supervises the runtime: restarts it with backoff up to `CUTTLELY_HERMES_MAX_RESTARTS`, ignores missed health checks during `CUTTLELY_HERMES_HEALTH_GRACE`, and needs `CUTTLELY_HERMES_HEALTH_FAILS` misses over `CUTTLELY_HERMES_HEALTH_WINDOW` before a restart. A run with an open event stream is not restarted for missed checks.

`GET /api/v1/ping` answers `pong` while the runtime is `up`, `degraded` or `restarting` (the `X-Cuttlely-Hermes` header says which) and HTTP 503 `hermes down` after the restart limit; the server itself stays up. The status file is `$CUTTLELY_DATA_DIR/hermes-supervisor.json`.

**Harness model and key (D9).** Connect a chat-model node to Harness Prime, select a credential on it when the node needs one, and save. Keys never come from the shell or the runtime's env files. Each harness profile under `$CUTTLELY_HERMES_HOME/profiles/` gets a `model:` block pointing at the loopback gateway and a per-profile gateway token, never a provider key. Never commit anything under `.cuttlely/`.

## Environment variables

Contributor-relevant variables. The admin panel registry (`packages/server/src/settings/registry.ts`) and `docs/how-to/server-settings.md` cover the rest.

| Variable                                                    | Default                                     | Meaning                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CUTTLELY_DATA_DIR`                                         | `<repo>/.cuttlely`                          | Harness records, queue, run history, workspaces, the runtime home                                    |
| `CUTTLELY_HERMES_HOME`                                      | `$CUTTLELY_DATA_DIR/hermes`                 | Agent runtime home and profiles                                                                      |
| `HERMES_API_PORT`, `HERMES_API_URL`                         | `8642`, `http://127.0.0.1:$HERMES_API_PORT` | Agent runtime API port and URL                                                                       |
| `HERMES_PYTHON`                                             | unset                                       | Python that runs the agent runtime                                                                   |
| `PORT`, `HOST`                                              | `43117`, server default                     | Public server address                                                                                |
| `DATABASE_PATH`, `SECRETKEY_PATH`                           | `~/.cuttlely`                               | Directories (not the sqlite file) for the database and `encryption.key`                              |
| `CUTTLELY_FLOWISE_DB`                                       | the sqlite file in `DATABASE_PATH`          | The sqlite file the harness credential reader opens. Do not set it with `DATABASE_TYPE=postgres`     |
| `CUTTLELY_EAGER_NODES`                                      | unset                                       | `true` loads every node at boot (D12)                                                                |
| `CUTTLELY_WARM_HERMES`, `CUTTLELY_HERMES_KEEP_WARM_MINUTES` | on, off                                     | Warm-up turns at boot and after a save; optional repeat every N minutes (D12)                        |
| `CUTTLELY_HARNESS_GATEWAY_PORT`                             | `43118`                                     | Loopback model gateway for agent-loop specialists (D9)                                               |
| `CUTTLELY_HARNESS_TURN_BUDGET_MS`                           | `45000`                                     | Wall clock per harness turn; `0` turns it off (D13)                                                  |
| `CUTTLELY_HARNESS_MODEL_FALLBACK_MS`                        | `8000`                                      | When a connected fallback model starts; `0` waits for a 502, 503 or 504 (D13)                        |
| `CUTTLELY_HARNESS_SPECIALIST_CONTEXT_TOKENS`                | `4000`                                      | Specialist prompt cap; `0` turns it off (D14)                                                        |
| `CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS`                     | `6000`                                      | Handoff cap; `0` turns it off (D14)                                                                  |
| `CUTTLELY_HARNESS_QUEUE`                                    | `inline`                                    | `inline`, `external` (start `harness/worker.mjs`) or `off` (D15)                                     |
| `CUTTLELY_HARNESS_WORKERS`                                  | `1` in external mode                        | Worker processes the start script launches                                                           |
| `CUTTLELY_HARNESS_WORKER_CONCURRENCY`                       | `4`                                         | Jobs the inline worker runs at once                                                                  |
| `CUTTLELY_HARNESS_LOCK_MS`                                  | turn budget plus 5 s                        | How long a dead worker may hold a chat; `0` never expires                                            |
| `CUTTLELY_BASE_URL`                                         | `http://127.0.0.1:$PORT`                    | `baseURL` passed to nodes in a harness run                                                           |
| `CUTTLELY_ETL_DIR`                                          | `$CUTTLELY_DATA_DIR/etl`                    | ETL database, uploads, cloned repositories and vectors                                               |
| `CUTTLELY_ETL_CONCURRENCY`                                  | `1`                                         | ETL runs at once                                                                                     |
| `CUTTLELY_ETL_ROOTS`                                        | unset                                       | Extra folders ETL sources may read, comma-separated `path` or `label=path`. Unset fails closed (D17) |
| `CUTTLELY_ETL_DEFAULT_WORKSPACE_ID`                         | unset                                       | Workspace for pipelines that have none                                                               |
| `CUTTLELY_ETL_SCHEDULE_MS`                                  | `15000`                                     | How often the scheduler looks for a due pipeline                                                     |
| `CUTTLELY_ANALYST`                                          | unset                                       | `auto` creates isolated analyst storage (D23)                                                        |
| `CUTTLELY_POSTGRES_URL`                                     | unset                                       | A separate analyst database. Never the application database. Needs `sslmode` for hosted Postgres     |
| `CUTTLELY_VERSIONS_DIR`, `CUTTLELY_DRAFTS`                  | `$CUTTLELY_DATA_DIR/versions`, on           | Version history location; `off` turns drafts off (D25)                                               |
| `CUTTLELY_LOCAL_ADMIN`                                      | unset                                       | `true` enables the one local account (D19). Leave it off on a public AuthKit deploy                  |
| `TRUST_PROXY`                                               | unset (trust none)                          | Proxy hop count in front of the server (D20)                                                         |
| `MODEL_LIST_CONFIG_JSON`                                    | unset                                       | `bundled` turns off the daily model list fetch (D32)                                                 |
| `CUTTLELY_STARTING_PAGE`                                    | on                                          | `off` skips the boot progress page (D34)                                                             |
| `CUTTLELY_DRAIN_TIMEOUT_MS`                                 | `25000`                                     | How long running answers and streams may finish after SIGTERM before they get a `503`                |
| `CUTTLELY_IGNORE_ADMIN_SETTINGS`                            | unset                                       | `1` starts without the admin settings file (D35)                                                     |

## Gotchas

-   **`DATABASE_PATH` and `SECRETKEY_PATH` are directories,** not `.../database.sqlite`. A file path there shows up as a disk I/O error when a harness reads credentials.
-   **Postgres is not `DATABASE_URL`.** The app reads `DATABASE_TYPE=postgres` plus `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER` and `DATABASE_PASSWORD` (`packages/server/src/DataSource.ts`).
-   **Restart after runtime code changes.** The server loads `harness/*.mjs` and `etl/*.mjs` once. Rebuild `packages/server` or `packages/components` after TypeScript changes.
-   **Stale node definitions.** A node file whose mtime or size changed is reloaded at boot. If the canvas still shows an old definition, delete `packages/components/dist/nodes-manifest.json` and restart.
-   **A harness needs a model on Harness Prime.** Saving without one fails with a clear message; a required credential that is missing or deleted fails with `missing_credential`; a model on a loopback or private address fails with `model_blocked` (D11).
-   **Gateway or runtime port in use.** Set `CUTTLELY_HARNESS_GATEWAY_PORT` or `HERMES_API_PORT` and restart. `$CUTTLELY_HERMES_HOME/.env` records the runtime port from the first start.
-   **SQLite WAL on a mounted drive.** On filesystems where WAL is unsafe (for example a Windows drive mounted into WSL), set `database: journal_mode: delete` in `$CUTTLELY_HERMES_HOME/config.yaml`, or keep the data folder on a native Linux volume. Builds and boots are also much slower on such drives.
-   **The runtime's `aiohttp` and `mcp` extras** are not in its base install. `scripts/setup-hermes.sh` installs both; a bare `uv sync --frozen` does not. Re-run the script after pulling a change to it.
-   **Native modules.** `sqlite3` and `faiss-node` are the only built dependencies. If a `.node` file is missing after install, run `prebuild-install -r napi` inside that package under `node_modules/.pnpm/`.
-   **Killing the server.** `pkill -f` on a pattern that also matches your own shell's command line kills the shell. Kill by port or pid instead, and make sure a test server you started does not outlive its job.
-   **Tool Agent needs memory.** A chatflow with a Tool Agent and the Harness tool fails without a memory node.
-   **Splitter inputs are strings.** A numeric `chunkOverlap` of `0` is ignored and the default overlap is used; the canvas stores `"0"`.
-   **ETL run results.** `partial` means some records were rejected and the rest written (more than 5% rejected after 100 reads fails instead). `missing_key_config` means a CSV, TSV or JSONL source needs a key column. `bad_source` means a path outside the allowed roots or another workspace's upload. `store_config` is a credential, index or namespace problem and is not retried. `store_count_*` results compare the store's own count with ETL's records; the run events explain each.
-   **Chatflow API keys are hashes.** A key cannot be shown again; create a new one if it was not saved (D22).
-   **Docker's published port is not loopback inside the container.** First-account registration from the host needs the one-time setup link the server prints in its log.
-   **A sticky bar inside a MUI `MainCard` does not stick,** because the card sets `overflow: hidden`. Give that card `sx={{ overflow: 'visible' }}` and check in a real browser.

## Harness queue and workers (D15)

```bash
bash scripts/start-cuttlely.sh                                                  # inline (default)
CUTTLELY_HARNESS_QUEUE=external CUTTLELY_HARNESS_WORKERS=1 bash scripts/start-cuttlely.sh
```

`harness/check.mjs` covers the queue offline: an inline job, a `busy` second turn for the same chat, two chats in parallel, abort, and a spawned worker. Do not commit the queue file.

## Live pressure tests

`scripts/live-e2e/` drives a running server and a test vector index. CI does not run it and the product does not import it. Read `scripts/live-e2e/README.md` first. Keys come from the environment or a `chmod 600` file outside the repository. Vector deletes are limited to test namespaces.

## Render

The Blueprint is `render.yaml` (D29). Apply it from the Render Dashboard; this repository never calls the Render API, and `pnpm verify` only checks the file. The full steps, including sign-in, are in `docs/how-to/render.md` and `docs/identity/workos-authkit-setup.md`.

-   A `render.yaml` change is server config: run the full `pnpm verify`.
-   The first sync asks for the `sync: false` values (the AuthKit variables and `CUTTLELY_BOOTSTRAP_EMAIL`). Never put their values in git, chat or shell history. Do not add provider API keys; harness models come from in-app credentials.
-   Confirm the plans before the first sync. The database name, user, region and Postgres major version, and the web runtime, cannot change after create.
-   Leave `numInstances` at 1. Wait for `GET /api/v1/ping` to return `pong`; the first boot is slow.
-   Losing `FLOWISE_SECRETKEY_OVERWRITE` makes stored credentials unreadable.
-   Analyst mode: set `CUTTLELY_ANALYST=auto` in the Dashboard, or a separate database in `CUTTLELY_POSTGRES_URL` when the database user cannot create roles (D23).

## Docker

```bash
docker compose config                                               # resolve the file; starts nothing
docker compose up -d                                                # pulls the published image, builds the root Dockerfile when the pull fails (D30)
docker compose up -d --build                                        # build this checkout on purpose
docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping
docker compose logs cuttlely                                        # the one-time setup link for the first account is in the log
bash scripts/docker-smoke.sh                                        # build, start and ping, for image changes
```

Compose mounts a volume at `/var/cuttlely` (the same layout as the Render disk) and uses SQLite. `CUTTLELY_IMAGE` pins a release or names a local build. Copy `.env.example` to `.env` only to override a default; never commit `.env`. `docker/Dockerfile` refuses to build; use the root `Dockerfile`.

The root `Dockerfile` has two stages. The build stage has the compilers, installs every package, builds, sets up Hermes, then installs `node_modules` again with production packages only. The runtime stage copies that tree, Hermes and its Python, and installs only the system packages Cuttlely runs with (git, Chromium, python3, curl, util-linux). A system library a new runtime feature needs goes in the runtime stage's `apt-get` list. A package that has to compile at install time goes in `onlyBuiltDependencies` in the root `package.json` and in the `pnpm -r rebuild` line. After an image change, build it, start it and check ping (`bash scripts/docker-smoke.sh`).

## Website

The website source is `website/` (Astro and Starlight, static, with its own npm lockfile outside the pnpm workspace). The docs are written only in `docs/`; `website/scripts/sync-docs.mjs` copies them in before each build. `website/README.md` has the commands (`npm ci`, `npm run dev`, `npm run build`, `npm test`). `pnpm verify` runs the website unit tests and the `website-docs` link check without installing the website, so a broken link in `docs/` fails the gate.

## Release

`pnpm release` (D30) runs from a clean `main` that matches `origin/main`. Steps and flags are in `docs/releases.md` under Cutting a release.

```bash
pnpm release --dry-run                # changes nothing: checks, plan, release notes
pnpm release                          # verify, bump, CHANGELOG, commit, tag, build and ping the image, push commit and tag, draft release
pnpm release X.Y.Z --push --publish   # on the tagged commit: push the image, publish the release
```

-   Product version files: root `package.json` and `packages/server/package.json`. Other workspace packages keep their own numbers.
-   The image is `linux/amd64` unless the buildx builder is `docker-container` with `linux/arm64`.
-   The release commit goes straight to `main` with the hook skips, because the full verify already ran on that tree. Branch protection must allow the releasing maintainer to bypass.
-   After a release, refresh the upgrade fixture (D31): build the release tag in its own checkout, run `node scripts/upgrade-fixture.mjs --server-root <that checkout> --out scripts/fixtures/upgrade`, and ship it as a pull request.
-   Model list updates need no release: edit `packages/components/models.json` and follow `docs/reference/model-list.md`.
