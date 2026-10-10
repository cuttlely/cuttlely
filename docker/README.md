# Cuttlely Docker

The install is the repository root [docker-compose.yml](../docker-compose.yml). It runs the published image `ghcr.io/cuttlely/cuttlely:latest` and uses SQLite. When the image cannot be pulled, Compose builds the root [Dockerfile](../Dockerfile) from this checkout instead. Postgres is not started. From the repo root:

```bash
docker compose up -d
```

Open [http://localhost:43117](http://localhost:43117) after ping returns `pong`. On a fresh install the server log prints a one-time setup link for the first account (`docker compose logs cuttlely | grep "No account yet"`). The steps are in the root [README](../README.md#your-first-10-minutes).

[docker/docker-compose.yml](./docker-compose.yml) uses the same image and the same SQLite paths, for a Compose command run in this directory. The service name is `cuttlely`. `CUTTLELY_IMAGE` in [.env.example](../.env.example) pins a release or names your own build. Image versions and upgrades are in [docs/how-to/docker.md](../docs/how-to/docker.md#image-versions).

`docker compose config` prints the resolved file and does not start containers.

`docker/Dockerfile` in this folder is not that image. Building it exits immediately and tells you to use the root `Dockerfile`. Compose does not build it. Releases are built and pushed from a maintainer machine with `pnpm release` ([docs/releases.md](../docs/releases.md)). The old Docker Hub publish workflow is removed.

Render is a separate path. The Blueprint is [render.yaml](../render.yaml), applied in the Render Dashboard. It sets `DATABASE_TYPE=postgres`. Local Compose does not. Steps are in [docs/how-to/render.md](../docs/how-to/render.md). Local Compose stays on SQLite. The env table is in [docs/how-to/docker.md](../docs/how-to/docker.md).

## Queue files

Cuttlely harness turns run in the Cuttlely process (`CUTTLELY_HARNESS_QUEUE` defaults to `inline`). These files are not the install:

-   [docker-compose-queue-source.yml](./docker-compose-queue-source.yml) and [docker-compose-queue-prebuilt.yml](./docker-compose-queue-prebuilt.yml) build the root Dockerfile and [worker/Dockerfile](./worker/Dockerfile). They do not pull an image. They still describe the old BullMQ layout (Redis, port 3000). That layout was not run for this change.
-   [worker/docker-compose.yml](./worker/docker-compose.yml) builds `docker/worker/Dockerfile` from this repository (`cuttlely-worker:local`). It does not pull an image.

Worker notes: [worker/README.md](./worker/README.md).
