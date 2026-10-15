# Upgrading Cuttlely

An upgrade has three steps: back up, upgrade, and check. If something goes wrong, you roll back by restoring the backup and starting the version you had before.

Read the release's entry in the [changelog](../CHANGELOG.md) first. Anything you have to change yourself is listed under **Upgrade notes / breaking changes**. [Releases and support](./releases.md) explains which versions get fixes.

## What to back up

Everything Cuttlely keeps is in one folder:

| Install        | Folder                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Docker Compose | The volume `cuttlely_cuttlely-data`, mounted at `/var/cuttlely`                                |
| `npx cuttlely` | The Docker volume `cuttlely-data`, mounted at `/var/cuttlely`                                  |
| Render         | The disk mounted at `/var/cuttlely`, plus the Postgres database                                |
| From source    | `~/.cuttlely` (database and key) and `<checkout>/.cuttlely` (history, harnesses, ETL, uploads) |

Inside it, `data/database.sqlite` is the database and `data/encryption.key` is the key that decrypts your credentials. A database backup without its key leaves every stored credential unreadable. `versions/` holds every saved version of your flows. `harnesses/`, `etl/` and `storage/` hold harness records, pipelines and uploads.

`settings/` holds the server settings file the admin panel saves (`server.json`, its last good copy and a change history). Secrets in it are encrypted with the same key.

If you set `DATABASE_PATH`, `SECRETKEY_PATH`, `CUTTLELY_DATA_DIR` or `FLOWISE_SECRETKEY_OVERWRITE` yourself, back up what they point to, and keep the key value. `CUTTLELY_SECRETKEY_OVERWRITE` is the same key. If both are set and the values differ, Cuttlely refuses to start.

## 1. Back up

Stop Cuttlely first, so the database file is complete.

**Docker.** Run these from the folder with `docker-compose.yml`. Compose names the volume `cuttlely_cuttlely-data`; `docker volume ls` shows it.

```bash
docker compose stop cuttlely
docker run --rm -v cuttlely_cuttlely-data:/var/cuttlely -v "$PWD":/backup busybox \
    tar czf /backup/cuttlely-backup.tgz -C /var/cuttlely .
```

Keep `cuttlely-backup.tgz` somewhere safe. It holds your encryption key.

**npm launcher.** Run `cuttlely stop`, then use the same `docker run` with the volume name `cuttlely-data`.

**From source.** Stop the server (Ctrl+C in its terminal), then:

```bash
tar czf cuttlely-backup.tgz -C ~ .cuttlely
tar czf cuttlely-checkout-data.tgz -C <checkout> .cuttlely
```

**Render.** Render snapshots the disk once a day and keeps each snapshot for at least seven days. You can restore a snapshot from the service's **Disk** page. For the database, export it with `pg_dump` using the connection string on the database's page in the Render Dashboard, or use the backups your Postgres plan includes.

## 2. Upgrade

**Docker, published image.**

```bash
docker compose pull
docker compose up -d
```

If you pinned a release with `CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:X.Y.Z` in `.env`, change the tag to the new version first.

**Docker, built from your checkout.**

```bash
git pull
docker compose up -d --build
```

**From source.**

```bash
git pull
pnpm install --frozen-lockfile
pnpm build
CUTTLELY_LOCAL_ADMIN=true bash scripts/start-cuttlely.sh
```

To move to a specific release instead of the newest `main`, run `git checkout vX.Y.Z` in place of `git pull`.

**Render.** Every push to `main` deploys. To move to a release, deploy that release's commit.

On the first start, Cuttlely updates its database by itself. That start can take a little longer. Do not stop it part way.

## 3. Check

1. Wait for ping to answer `pong`. On Docker: `docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping`, or `docker compose ps` until it says `healthy`.
2. Check the version: `curl -fsS http://localhost:43117/api/v1/version`, or open the About dialog from the profile menu.
3. Sign in. Open a flow, its **Version history**, **Credentials** and your harnesses. Ask a flow one question.

## Roll back

A new version can change the database in ways the version before it cannot read. To roll back, restore the backup you took and start the version you had before. Do not start an older version on a database a newer one has already opened.

**Docker.**

```bash
docker compose down
docker run --rm -v cuttlely_cuttlely-data:/var/cuttlely -v "$PWD":/backup busybox \
    sh -c 'rm -rf /var/cuttlely/* /var/cuttlely/.[!.]* ; tar xzf /backup/cuttlely-backup.tgz -C /var/cuttlely'
```

Then set `CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:<the version you had>` in `.env` and run `docker compose up -d`.

**From source.** Stop the server, run `git checkout v<the version you had>`, `pnpm install --frozen-lockfile` and `pnpm build`. Put the two backed-up `.cuttlely` folders back in place, then start the server.

**Render.** Restore the disk snapshot from before the upgrade on the **Disk** page, restore the database from your export or backup, and deploy the commit you had before.

## If a server setting stops Cuttlely from starting

Settings saved from **Admin**, **Server Settings** apply when Cuttlely starts. If two starts in a row do not finish after a change, Cuttlely puts back the last settings that started and says so in the log. The settings that did not start are kept beside them as `server.rolled-back.json`.

You can also fix it by hand. Most changes apply at the next start. The sign-in failure limit, the two session lifetimes, and the shutdown wait apply without a restart. A host value overrides the saved one. Secret values are never printed.

| Command                    | What it does                                                  |
| -------------------------- | ------------------------------------------------------------- |
| `pnpm settings list`       | What is set, and whether it comes from the host or the file   |
| `pnpm settings unset NAME` | Removes one saved setting, for example `CUTTLELY_LOCAL_ADMIN` |
| `pnpm settings restore`    | Goes back to the last settings that started                   |

In Docker, run them as the `node` user: `docker compose exec -u node Cuttlely pnpm settings list`. To start once without the file, set `CUTTLELY_IGNORE_ADMIN_SETTINGS=1` (in `.env` for Docker, in the shell from source, or as an environment variable on Render).

## How upgrades are tested

Every full `pnpm verify` runs an upgrade check. It starts the current server on data written by an older cuttlely: a chatflow with two saved versions, an agentflow, a harness with two specialists, and a credential. It then checks that each of these survived, and that a question to the chatflow still gets an answer, which proves the credential still decrypts. It also checks that a new save records a version and that a second start works. Run it on its own with `pnpm upgrade:check`.

For maintainers: the data is in `scripts/fixtures/upgrade/`, made by `node scripts/upgrade-fixture.mjs --server-root <built checkout of the older version>`. After each release, refresh it from that release's tag so the check always starts from the last version people run.
