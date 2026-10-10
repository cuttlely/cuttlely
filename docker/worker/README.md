# Cuttlely worker image

Cuttlely does not pull a worker image. Harness turns run in the Cuttlely process. The install is the repository root `docker-compose.yml` (SQLite, port 43117). See the root [README](../../README.md).

`docker-compose.yml` in this folder builds [Dockerfile](./Dockerfile) from this repository and tags it `cuttlely-worker:local`. The Dockerfile copies the repo and runs `pnpm run start-worker`. That is the old BullMQ worker, not the install path. It was not started as part of the README check.
