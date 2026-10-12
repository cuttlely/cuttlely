# Docker

The install is the repository root `docker-compose.yml`. It runs the published image, `ghcr.io/cuttlely/cuttlely`. When that image cannot be pulled, Compose builds the root `Dockerfile` from your checkout instead. The app database is SQLite. Compose does not start Postgres.

## Database

The database is SQLite unless you change it. Compose leaves `DATABASE_TYPE` unset, which is SQLite. The file is `/var/cuttlely/data/database.sqlite`. `DATABASE_PATH` is that directory (`/var/cuttlely/data`), not the file. Compose does not start Postgres.

Postgres is [from-source.md](./from-source.md): `DATABASE_TYPE=postgres` plus `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, and `DATABASE_PASSWORD`. The Render Blueprint sets those for a hosted database ([render.md](./render.md)). Cuttlely does not read `DATABASE_URL`.

The owner can also switch from the browser: **Admin**, then **Server Settings**, then **Database**, then **Switch database**. It tests the new database first, says whether it is empty or already has Cuttlely data, explains how you sign in afterwards, and asks you to type `RESTART`. Nothing is copied between databases, and **Switch back** returns to the previous one. A database set in `.env` or the compose file shows as set by the host and can only be changed there.

```bash
git clone https://github.com/cuttlely/cuttlely.git
cd cuttlely
docker compose up -d
```

Compose pulls `ghcr.io/cuttlely/cuttlely:latest`. If it cannot pull it, Compose prints a warning and builds the image from your checkout, which takes several minutes the first time.

## Install with npm

With Node.js 20 or newer and Docker running:

```bash
npx cuttlely start
```

`npx cuttlely` pulls `ghcr.io/cuttlely/cuttlely`, tagged with the same version as the `cuttlely` package (`1.0.0` unless you pass `--tag`). It stores data in the Docker volume `cuttlely-data`, publishes port 43117, and opens [http://localhost:43117](http://localhost:43117) when `/api/v1/ping` answers `pong`. This is the same image Compose pulls. Compose keeps its data in the volume `cuttlely_cuttlely-data`. `cuttlely start` keeps its data in the volume `cuttlely-data`.

```bash
npx cuttlely stop
npx cuttlely status
npx cuttlely logs
npx cuttlely upgrade
npx cuttlely start --port 8080 --tag 1.0.0 --env-file .env --no-open
```

`--port` is the host and container port (default `43117`). `--tag` selects the image tag (default is the package version). `--env-file` is passed to Docker for extra settings such as `CUTTLELY_ANALYST`. `--no-open` prints the URL and skips the browser. A global install is `npm install -g cuttlely`, then `cuttlely start`.

If Docker is missing or not running, the command says so and links to this page. The first account is the same as Compose: the one-time setup link is in `npx cuttlely logs`.

### Watch it start

Pulling, building and the first start can take minutes. They never sit silent:

-   **Build.** When Compose builds instead of pulling, each long build step names itself: `Cuttlely image, step 1 of 5: build tools` up to `step 5 of 5: keeping production packages only`.
-   **Status.** `docker compose ps` shows `(health: starting)` in the STATUS column while Cuttlely boots, and `(healthy)` once it is ready.
-   **Logs.** `docker compose logs -f cuttlely` shows the boot steps (`Cuttlely boot, step 1 of 2: starting the server`, then `Loading nodes`), then a ready line with the address, `✅ Cuttlely is ready. Open http://localhost:43117`, and on a new install the one-time setup link.
-   **Browser.** Opening [http://localhost:43117](http://localhost:43117) before it is ready shows a **Cuttlely is starting** page with the current step. It opens Cuttlely by itself when it is ready.

A script can wait for ping instead: it answers `pong` when Cuttlely is ready (`503` with `"status":"starting"` while it boots).

Ping also answers `503` with a plain reason, such as `database unreachable: connection refused`, while Cuttlely can't reach its database, at startup or later. `docker compose ps` then shows the container as unhealthy, and the log has one line naming the database host and port (never the password). It answers `pong` again as soon as the database does. A start that never opened its database recovers only by starting again: `docker compose restart cuttlely`.

```bash
docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping
```

`docker compose up -d` reuses the image you already have. `docker compose down` keeps the volume. `docker compose down -v` deletes it.

**Stopping.** `docker compose stop`, `down` and an upgrade let answers that are running finish first, for up to 25 seconds (set `CUTTLELY_DRAIN_TIMEOUT_MS`, in milliseconds, under `environment` in the compose file to change it). New requests get `503` with `Retry-After` meanwhile. The compose file gives the container 35 seconds to stop; raise `stop_grace_period` with the drain time.

## Image versions

Each release is published as `ghcr.io/cuttlely/cuttlely:X.Y.Z`, and the newest release is also `:latest`. The [changelog](../../CHANGELOG.md) lists what changed in each one.

-   **Pin a release.** Set `CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:1.0.0` in `.env`, then run `docker compose up -d`.
-   **Move to the newest release.** Run `docker compose pull`, then `docker compose up -d`. Back up the volume first and read the release's upgrade notes in the changelog. [Upgrading Cuttlely](../upgrading.md) has the backup, upgrade and roll back steps.
-   **Build your own checkout.** Run `docker compose up -d --build`. The build is tagged with the `CUTTLELY_IMAGE` name, so set `CUTTLELY_IMAGE=cuttlely:local` in `.env` to keep it apart from the published image.

The image is built for `linux/amd64`. A release can also carry `linux/arm64` when it was built on a machine that can build both. On Apple silicon, Docker runs the `amd64` image under emulation.

`docker/docker-compose.yml` uses the same image and the same SQLite settings if you run Compose from that directory. The service name is `cuttlely`. `docker/Dockerfile` is not this image. Building it exits and tells you to use the root `Dockerfile`. Compose does not build it.

`docker compose config` prints the file and does not start containers.

## Leave out the geolocation database

The default image includes the IP geolocation database (`geoip-lite`). Audit events use it to record a country and a region, then mask the IP. It is the largest package in the image. A normal build keeps it, and audit events stay the same.

A build can leave the database out:

```bash
docker build --build-arg CUTTLELY_OMIT_GEOIP=true -t cuttlely:local .
```

`CUTTLELY_OMIT_GEOIP` defaults to `false`. Set it to `true` and the image build leaves `geoip-lite` out after the production install. The server still starts. Audit events then have no country and no region, the same result as an IP the database does not know. `docker compose up -d --build` does not pass this argument, so that build keeps the database.

The argument applies at build time. Changing it means building the image again. To run the image you just built, set `CUTTLELY_IMAGE=cuttlely:local` in `.env` and run `docker compose up -d`.

## Data

SQLite is `/var/cuttlely/data/database.sqlite` on the named volume `cuttlely-data`. Uploads, harness files, ETL files, logs, the agent runtime home, and version history (`/var/cuttlely/versions`, see [Version history](./versioning.md#where-the-history-lives)) are the other directories on that volume. The first boot writes `encryption.key` in `/var/cuttlely/data`. Losing the volume, or changing `FLOWISE_SECRETKEY_OVERWRITE`, makes stored credentials unreadable.

Copy `.env.example` to `.env` only to change a default. `.env` is gitignored.

| Variable                      | Default                            | Notes                                                                                                                                                                           |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                        | `43117`                            | Host and container.                                                                                                                                                             |
| `HOST`                        | `0.0.0.0`                          |                                                                                                                                                                                 |
| `DATABASE_TYPE`               | unset (SQLite)                     | App database. Compose does not set it. Compose does not start Postgres.                                                                                                         |
| `DATABASE_PATH`               | `/var/cuttlely/data`               | Directory. The file inside it is `database.sqlite`.                                                                                                                             |
| `CUTTLELY_ANALYST`            | unset                              | Set `auto` to give each workspace its own analyst store, `analyst-<tag>.db` beside the app file. Auto mode can create and change tables. An explicit Postgres URL is read-only. |
| `SECRETKEY_PATH`              | `/var/cuttlely/data`               | `encryption.key` and auth-secret files.                                                                                                                                         |
| `BLOB_STORAGE_PATH`           | `/var/cuttlely/storage`            | Uploads.                                                                                                                                                                        |
| `CUTTLELY_DATA_DIR`           | `/var/cuttlely`                    | Harness records and `harness-queue.sqlite`.                                                                                                                                     |
| `CUTTLELY_HERMES_HOME`        | `/var/cuttlely/hermes`             | Agent runtime state. `HERMES_HOME` matches it.                                                                                                                                  |
| `CUTTLELY_ETL_DIR`            | `/var/cuttlely/etl`                | ETL sqlite and files.                                                                                                                                                           |
| `CUTTLELY_VERSIONS`           | unset                              | Version history is on. Set `CUTTLELY_VERSIONS=off` in `.env`, then `docker compose up -d`, to turn it off. [History settings](../reference/versioning-settings.md).             |
| `CUTTLELY_DRAFTS`             | unset                              | Drafts are on. Set `CUTTLELY_DRAFTS=off` in `.env`, then `docker compose up -d`, to save to Live. [History settings](../reference/versioning-settings.md).                      |
| `LOG_PATH`                    | `/var/cuttlely/logs`               |                                                                                                                                                                                 |
| `CUTTLELY_LOCAL_ADMIN`        | `true`                             | The local account and its password form. Blank keeps it on. Set `false` when you use WorkOS or publish the port beyond your machine. [Sign in](./sign-in.md).                   |
| `CUTTLELY_INSTALL`            | `docker`                           | Set by Compose so the start script knows this is Docker and keeps the local account on by default. Leave it as it is.                                                           |
| `FLOWISE_SECRETKEY_OVERWRITE` | unset                              | Leave unset unless you want your own key. Never commit it.                                                                                                                      |
| `CUTTLELY_IMAGE`              | `ghcr.io/cuttlely/cuttlely:latest` | The image Compose pulls, and the tag a local build gets. Pin a release with `:X.Y.Z`.                                                                                           |

Queue files under `docker/` are not this install. They build this repository and do not pull an image. See [docker/README.md](../../docker/README.md).

Create the first account with [sign-in.md](./sign-in.md). SQLite is the default above. A Postgres server you already run uses the variables in [from-source.md](./from-source.md). A hosted Postgres install is [render.md](./render.md). Analyst mode, including QUERY and a read-only URL, is [analyst.md](./analyst.md).
