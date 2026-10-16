<!-- markdownlint-disable MD030 -->

# Contributing to Cuttlely

English | [中文](./i18n/CONTRIBUTING-ZH.md)

We appreciate any form of contributions.

## ⭐ Star

Star and share the [Cuttlely repository](https://github.com/cuttlely/cuttlely).

## Questions

Open an issue on the [Cuttlely repository](https://github.com/cuttlely/cuttlely/issues).

## Share a chat flow

Export a chat flow as JSON, attach a screenshot, and open an issue or pull request.

## Ideas

Feature ideas are welcome, including new nodes and harness patterns. Open an issue.

## Report bugs

Found an issue? [Report it](https://github.com/cuttlely/cuttlely/issues).

A vulnerability is not a public bug. Report it the way [SECURITY.md](./SECURITY.md) describes.

## 👨‍💻 Contribute to Code

Not sure what to contribute? Some ideas:

-   Create new components from `packages/components`
-   Update existing components such as extending functionality, fixing bugs
-   Add new chatflow ideas

### Developers

Cuttlely has 3 different modules in a single mono repository. New modules follow the boundary map in [ARCHITECTURE.md](./ARCHITECTURE.md).

-   `server`: Node backend to serve API logics
-   `ui`: React frontend
-   `components`: Third-party nodes integrations

#### Build from source and run the dev server

[Build from source and run the dev server](./docs/how-to/from-source.md) is the step-by-step guide: Node 24 and pnpm through Corepack, install, build, start Cuttlely, run the dev server with live reload, run the tests, and `pnpm verify`. In short:

```bash
corepack enable
git clone https://github.com/<you>/cuttlely.git   # your fork
cd cuttlely
pnpm install
pnpm build
bash scripts/setup-hermes.sh
CUTTLELY_LOCAL_ADMIN=true pnpm dev                # open http://localhost:8080
```

`pnpm dev` serves the UI on `8080` with live reload and the server on `3000`. Server changes need `pnpm --filter @cuttlely/server build`, and node changes need `pnpm --filter @cuttlely/components build`. [What updates when you save](./docs/how-to/from-source.md#what-updates-when-you-save) has the details.

#### Step by step

1. Fork the [Cuttlely repository](https://github.com/cuttlely/cuttlely) and clone your fork.

2. Create a new branch, see [guide](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-and-deleting-branches-within-your-repository). Naming conventions:

    - For feature branch: `feature/<Your New Feature>`
    - For bug fix branch: `bugfix/<Your New Bugfix>`.

3. Install, build and run the dev server as the [guide](./docs/how-to/from-source.md) shows, and make your change.

4. Run `pnpm verify`. See [Verify before a pull request](#verify-before-a-pull-request).

5. Commit your change and open a pull request from your branch to [Cuttlely main](https://github.com/cuttlely/cuttlely/tree/main).

### Adding or modifying credential definitions

Credential definitions live in `packages/components/credentials/`. Each input field has a `type` that controls both UI rendering and how the value is handled on the server.

**Security rule: any field that contains a secret must use `type: 'url'` or `type: 'password'` — never `type: 'string'`.**

The server redacts both `url` and `password` fields before returning credential data to the client. Fields typed `string` are returned in plaintext, which exposes stored secrets to any authenticated user with `credentials:view` permission.

Use `type: 'url'` for connection strings with embedded credentials:

-   Connection URLs that embed a username/password (e.g. `mongodb+srv://user:pass@host/db`, `redis://:pass@host`, `postgresql://user:pass@host/db`)
-   Displayed with the password portion masked (e.g. `mongodb+srv://user:••••••@host/db`); users with edit permission can reveal the full URL

Use `type: 'password'` for opaque secrets with no meaningful preview:

-   API keys, access keys, secret keys, tokens
-   JSON blobs containing private keys or certificates (e.g. Google service account JSON)
-   Fully redacted in the UI; users must replace the entire value to update them

Fields that are safe as `type: 'string'`:

-   Usernames / account names (when the password is a separate field)
-   Region, host, port, database name, project ID
-   Non-secret identifiers and configuration values

If in doubt, use `type: 'password'`. The only cost is that the field must be re-entered on edit; the cost of using `type: 'string'` for a secret is that it is exposed via the API.

### Testing

-   Unit tests are **co-located** with their source files — a test for `Foo.ts` lives in `Foo.test.ts` in the same directory. This is the standard used across all packages in this repo.

-   Run tests per package:

    ```bash
    cd packages/server && pnpm test
    cd packages/components && pnpm test
    ```

    Or from the repo root using `--filter`:

    ```bash
    pnpm --filter @cuttlely/components test
    pnpm --filter @cuttlely/server test # the server package. The root package is named Cuttlely.
    ```

-   Or run all tests from the repo root:

    ```bash
    pnpm test
    ```

-   When adding new functionality, place your test file next to the source file it tests:

    ```
    packages/components/nodes/tools/MyTool/
    ├── MyTool.ts
    └── MyTool.test.ts        ← co-located test
    ```

## 🌱 Env Variables

Cuttlely supports the environment variables below. Put them in the `.env` file inside `packages/server`. Names that start with `FLOWISE_` are existing server settings; they are not the product name.

| Variable                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Type                                             | Default                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| PORT                                 | The HTTP port Cuttlely runs on                                                                                                                                                                                                                                                                                                                                                                                                                                      | Number                                           | 3000                                 |
| CORS_ALLOW_CREDENTIALS               | Enables CORS `Access-Control-Allow-Credentials` when `true`                                                                                                                                                                                                                                                                                                                                                                                                         | Boolean                                          | false                                |
| CORS_ORIGINS                         | The allowed origins for all cross-origin HTTP calls                                                                                                                                                                                                                                                                                                                                                                                                                 | String                                           |                                      |
| MCP_CORS_ORIGINS                     | The allowed origins for MCP endpoint cross-origin calls. If unset, only non-browser (no Origin header) requests are allowed. Set to `*` to allow all origins.                                                                                                                                                                                                                                                                                                       | String                                           |                                      |
| IFRAME_ORIGINS                       | The allowed origins for iframe src embedding                                                                                                                                                                                                                                                                                                                                                                                                                        | String                                           |                                      |
| FLOWISE_FILE_SIZE_LIMIT              | Upload File Size Limit                                                                                                                                                                                                                                                                                                                                                                                                                                              | String                                           | 50mb                                 |
| CUTTLELY_FILE_SIZE_LIMIT             | Compatibility alias for the upload file size limit. The existing name is still supported. When both are set, this name is used.                                                                                                                                                                                                                                                                                                                                     | String                                           | 50mb                                 |
| CUSTOM_MCP_TOOLS_MAX_BYTES           | Maximum byte size of the JSON tools payload stored per Custom MCP Server row (after stringify). Rejects oversized payloads returned by remote MCP servers. Set to `0` to disable the check.                                                                                                                                                                                                                                                                         | Number                                           | 524288 (512 KB)                      |
| CUSTOM_MCP_AUTHORIZE_TIMEOUT_MS      | Maximum time in milliseconds to wait for the MCP server handshake during authorize. Bounds the request so a slow/tarpit upstream cannot tie up the HTTP worker indefinitely. Minimum 1000.                                                                                                                                                                                                                                                                          | Number                                           | 15000                                |
| DEBUG                                | Print logs from components                                                                                                                                                                                                                                                                                                                                                                                                                                          | Boolean                                          |                                      |
| LOG_PATH                             | Directory of server log files. **Admin** > **Logs** reads it for an owner or a role with `logs:view`. Presets send a range token the server expands on its own clock. Custom sends the browser's `YYYY-MM-DD-HH` stamps, which the server reads as its own local hours. Redaction runs on the joined text, so a secret that spans lines becomes `[secret hidden]`. A capped tail keeps lines from the first log record and marks the cut as `[earlier output cut]`. | String                                           | `your-path/cuttlely/logs`            |
| LOG_LEVEL                            | Different levels of logs                                                                                                                                                                                                                                                                                                                                                                                                                                            | Enum String: `error`, `info`, `verbose`, `debug` | `info`                               |
| LOG_JSON_SPACES                      | Spaces to beautify JSON logs                                                                                                                                                                                                                                                                                                                                                                                                                                        |                                                  | 2                                    |
| TOOL_FUNCTION_BUILTIN_DEP            | NodeJS built-in modules to be used for Custom Tool or Function                                                                                                                                                                                                                                                                                                                                                                                                      | String                                           |                                      |
| TOOL_FUNCTION_EXTERNAL_DEP           | External modules to be used for Custom Tool or Function                                                                                                                                                                                                                                                                                                                                                                                                             | String                                           |                                      |
| ALLOW_BUILTIN_DEP                    | Allow project dependencies to be used for Custom Tool or Function                                                                                                                                                                                                                                                                                                                                                                                                   | Boolean                                          | false                                |
| DATABASE_TYPE                        | Type of database to store Cuttlely data                                                                                                                                                                                                                                                                                                                                                                                                                             | Enum String: `sqlite`, `mysql`, `postgres`       | `sqlite`                             |
| DATABASE_PATH                        | Location where database is saved (When DATABASE_TYPE is sqlite)                                                                                                                                                                                                                                                                                                                                                                                                     | String                                           | `your-home-dir/.cuttlely`            |
| DATABASE_HOST                        | Host URL or IP address (When DATABASE_TYPE is not sqlite)                                                                                                                                                                                                                                                                                                                                                                                                           | String                                           |                                      |
| DATABASE_PORT                        | Database port (When DATABASE_TYPE is not sqlite)                                                                                                                                                                                                                                                                                                                                                                                                                    | String                                           |                                      |
| DATABASE_USER                        | Database username (When DATABASE_TYPE is not sqlite)                                                                                                                                                                                                                                                                                                                                                                                                                | String                                           |                                      |
| DATABASE_PASSWORD                    | Database password (When DATABASE_TYPE is not sqlite)                                                                                                                                                                                                                                                                                                                                                                                                                | String                                           |                                      |
| DATABASE_NAME                        | Database name (When DATABASE_TYPE is not sqlite)                                                                                                                                                                                                                                                                                                                                                                                                                    | String                                           |                                      |
| DATABASE_SSL_KEY_BASE64              | Database SSL client cert in base64 (takes priority over DATABASE_SSL)                                                                                                                                                                                                                                                                                                                                                                                               | Boolean                                          | false                                |
| DATABASE_SSL                         | Database connection overssl (When DATABASE_TYPE is postgre)                                                                                                                                                                                                                                                                                                                                                                                                         | Boolean                                          | false                                |
| SECRETKEY_PATH                       | Location where encryption key (used to encrypt/decrypt credentials) is saved                                                                                                                                                                                                                                                                                                                                                                                        | String                                           | `your-path/cuttlely/packages/server` |
| FLOWISE_SECRETKEY_OVERWRITE          | Encryption key to be used instead of the key stored in SECRETKEY_PATH                                                                                                                                                                                                                                                                                                                                                                                               | String                                           |                                      |
| CUTTLELY_SECRETKEY_OVERWRITE         | Compatibility alias for the encryption key overwrite. The existing name is still supported. When both are set to the same value, that value is used. When they differ, Cuttlely refuses to start.                                                                                                                                                                                                                                                                   | String                                           |                                      |
| DISABLE_CUTTLELY_TELEMETRY           | Set to `true` to turn off usage events. The existing disable variable is still supported. When both are set, this name is used.                                                                                                                                                                                                                                                                                                                                     | String                                           |                                      |
| METRICS_PREFIX                       | Optional prefix for published metric names. Unset or empty keeps today's names.                                                                                                                                                                                                                                                                                                                                                                                     | String                                           |                                      |
| MODEL_LIST_CONFIG_JSON               | Unset: fetch the maintainers' model list from this repository daily, bundled copy as fallback. `bundled`: no fetch. Or a file path or URL. See [Updating the model list](docs/reference/model-list.md)                                                                                                                                                                                                                                                              | String                                           |                                      |
| STORAGE_TYPE                         | Type of storage for uploaded files. default is `local`                                                                                                                                                                                                                                                                                                                                                                                                              | Enum String: `s3`, `local`, `gcs` ,`azure`       | `local`                              |
| BLOB_STORAGE_PATH                    | Local folder path where uploaded files are stored when `STORAGE_TYPE` is `local`                                                                                                                                                                                                                                                                                                                                                                                    | String                                           | `your-home-dir/.cuttlely/storage`    |
| S3_STORAGE_BUCKET_NAME               | Bucket name to hold the uploaded files when `STORAGE_TYPE` is `s3`                                                                                                                                                                                                                                                                                                                                                                                                  | String                                           |                                      |
| S3_STORAGE_ACCESS_KEY_ID             | AWS Access Key                                                                                                                                                                                                                                                                                                                                                                                                                                                      | String                                           |                                      |
| S3_STORAGE_SECRET_ACCESS_KEY         | AWS Secret Key                                                                                                                                                                                                                                                                                                                                                                                                                                                      | String                                           |                                      |
| S3_STORAGE_REGION                    | Region for S3 bucket                                                                                                                                                                                                                                                                                                                                                                                                                                                | String                                           |                                      |
| S3_ENDPOINT_URL                      | Custom Endpoint for S3                                                                                                                                                                                                                                                                                                                                                                                                                                              | String                                           |                                      |
| S3_FORCE_PATH_STYLE                  | Set this to true to force the request to use path-style addressing                                                                                                                                                                                                                                                                                                                                                                                                  | Boolean                                          | false                                |
| GOOGLE_CLOUD_STORAGE_PROJ_ID         | The GCP project id for cloud storage & logging when `STORAGE_TYPE` is `gcs`                                                                                                                                                                                                                                                                                                                                                                                         | String                                           |                                      |
| GOOGLE_CLOUD_STORAGE_CREDENTIAL      | The credential key file path when `STORAGE_TYPE` is `gcs`                                                                                                                                                                                                                                                                                                                                                                                                           | String                                           |                                      |
| GOOGLE_CLOUD_STORAGE_BUCKET_NAME     | Bucket name to hold the uploaded files when `STORAGE_TYPE` is `gcs`                                                                                                                                                                                                                                                                                                                                                                                                 | String                                           |                                      |
| GOOGLE_CLOUD_UNIFORM_BUCKET_ACCESS   | Enable uniform bucket level access when `STORAGE_TYPE` is `gcs`                                                                                                                                                                                                                                                                                                                                                                                                     | Boolean                                          | true                                 |
| AZURE_BLOB_STORAGE_CONNECTION_STRING | Azure Blob Storage connection string when `STORAGE_TYPE` is `azure`. Either this or account name + key is required                                                                                                                                                                                                                                                                                                                                                  | String                                           |                                      |
| AZURE_BLOB_STORAGE_ACCOUNT_NAME      | Azure storage account name when `STORAGE_TYPE` is `azure`. Required if connection string is not provided                                                                                                                                                                                                                                                                                                                                                            | String                                           |                                      |
| AZURE_BLOB_STORAGE_ACCOUNT_KEY       | Azure storage account key when `STORAGE_TYPE` is `azure`. Required if connection string is not provided                                                                                                                                                                                                                                                                                                                                                             | String                                           |                                      |
| AZURE_BLOB_STORAGE_CONTAINER_NAME    | Container name to hold the uploaded files when `STORAGE_TYPE` is `azure`                                                                                                                                                                                                                                                                                                                                                                                            | String                                           |                                      |
| SHOW_COMMUNITY_NODES                 | Show nodes created by community                                                                                                                                                                                                                                                                                                                                                                                                                                     | Boolean                                          |                                      |
| CANVAS_CARD_LOOK                     | Canvas cards for people who have not picked a look. `new`: compact cards, a click opens the settings in a side panel. `classic`: every setting on the card. Each person can still turn Classic cards on or off in the profile menu                                                                                                                                                                                                                                  | Enum String: `new`, `classic`                    | `new`                                |
| DISABLED_NODES                       | Hide nodes from UI (comma separated list of node names)                                                                                                                                                                                                                                                                                                                                                                                                             | String                                           |                                      |
| TRUST_PROXY                          | Configure proxy trust settings for proper IP detection. Values: 'true' (trust all), 'false' (disable), number (hop count), or Express proxy values (e.g., 'loopback', 'linklocal', 'uniquelocal', IP addresses). [Learn More](https://expressjs.com/en/guide/behind-proxies.html)                                                                                                                                                                                   | Boolean/String/Number                            | true                                 |

From this repository, start Cuttlely and Hermes together with `bash scripts/start-cuttlely.sh`. That script sets `PORT=43117` unless `PORT` is already set, and runs Hermes with `HERMES_PYTHON`, else `hermes/.venv/bin/python` (created by `bash scripts/setup-hermes.sh`), else `python3` (see [Build from source and run the dev server](./docs/how-to/from-source.md)). The server package binary is still named `flowise`:

```
npx flowise start --PORT=3000 --DEBUG=true
```

The same script is also `cuttlely-server`:

```
npx cuttlely-server start --PORT=3000 --DEBUG=true
```

## Docs

Update the README, this file, and `docker/README.md` so they describe Cuttlely.

## Vendored Hermes

`hermes/` is a trimmed copy of one upstream Hermes commit plus Cuttlely's patches in `hermes/patches/`. Do not edit it by hand without saving the change as a patch. [Hermes upgrades](./docs/reference/hermes-upgrades.md) explains `pnpm hermes:vendor`, how to upgrade, what to do when a patch does not apply, and how to change a Hermes file.

## Verify before a pull request

From a clean Node 24 install:

```bash
pnpm install
pnpm verify
```

`pnpm verify` is the check to run before a pull request. A pull request that only changes docs or markdown can use `pnpm verify --fast`. Anything that changes server code, tests, `scripts/verify.mjs`, hooks, package manifests, or `render.yaml` needs the full run. The README section [Contributing](./README.md#contributing) is the same rule. Workflows in `.github/workflows/` are the CI definition.

The run ends with a timing table of the steps that ran, slowest first, and `.verify/verify-summary.md` keeps each step's time.

Two checks guard what a pull request can add:

-   **Media size.** An image or video file over 5 MB fails `pnpm verify` (including `--fast` and the pre-push hook) and the required `lint` CI job. Compress it or host it outside the repository. `scripts/media-size.allowlist` lists the large files that were committed before the check. Do not add a new file there. Remove a line when that file is deleted or shrinks under 5 MB; the check fails until you do. Run it alone with `node scripts/media-size.mjs`.
-   **Proprietary paths.** `extensions/`, `apps/` other than `apps/oss-app/`, and the commercial identity tree are refused by the required `lint` CI job. `pnpm verify` does not run it. Run it locally with `node scripts/proprietary-paths.mjs`.

`pnpm harness:check` is the offline harness check (no model key). `pnpm etl:check` is the offline ETL check. `node harness/check.mjs` and `node etl/check.mjs` still run those checks for one release.

`pnpm test:queue-abort` checks queue mode end to end: it starts a server and a worker on a throwaway queue, stops a streaming prediction partway, and checks that the worker stops the run and saves no messages. It needs a built server (`pnpm build`) and a Redis it can use, for example `docker run -d --rm --name cuttlely-test-redis -p 127.0.0.1:6390:6379 redis:7-alpine`, then `REDIS_URL=redis://127.0.0.1:6390 pnpm test:queue-abort`. It uses a placeholder model, so it needs no model key. `QUEUE_ABORT_KEEP=1` keeps its temporary data folder for a look after a failure. `pnpm verify` does not run it; the daily scheduled CI run on `main` does.

The project notes in [`.projects/cuttlely/`](./.projects/cuttlely/README.md) say where the work stands, what is planned and open, the settled design decisions, and the commands to check and ship a change. Read them before a larger change. A code change updates them in the same pull request; the pre-push hook checks this. If you work with an AI agent, the `take-over` skill reads the notes and resumes from them.

Branch names in this repository are short and descriptive (`feature/…`, `bugfix/…`, or a maintainer prefix such as `flowbit/…`). Open the pull request against `main`.

## How releases work

Cuttlely uses [semantic versioning](https://semver.org/). [Releases and support](./docs/releases.md) explains what counts as a breaking change and which versions get fixes.

-   **In your pull request.** If the change is something users see, add a line under `## [Unreleased]` in [CHANGELOG.md](./CHANGELOG.md). Anything people must change when they upgrade also goes under **Upgrade notes / breaking changes**. Do not bump version numbers yourself.
-   **Cutting a release.** A maintainer runs `pnpm release` from a clean, up-to-date `main` on their own machine. It runs the full `pnpm verify`, sets the version, dates the changelog entry, tags the release, builds the Docker image and drafts the GitHub release. Pushing the image and publishing the release are separate flags (`--push`, `--publish`), and `pnpm release --dry-run` shows the whole plan without changing anything. [Cutting a release](./docs/releases.md#cutting-a-release) has the steps.
-   **Upgrades are tested.** The full `pnpm verify` starts the current server on data written by an older release and checks that flows, versions, credentials and harnesses survive. See [Upgrading Cuttlely](./docs/upgrading.md#how-upgrades-are-tested).

## Pull request process

Open a pull request against `main` on the [Cuttlely repository](https://github.com/cuttlely/cuttlely).

## Code of Conduct

This project and everyone participating in it are governed by the Code of Conduct in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report unacceptable behavior by opening an issue on the Cuttlely repository.
