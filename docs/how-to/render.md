# Render

Use this guide to run Cuttlely on [Render](https://render.com) with the Blueprint in this repository. A Blueprint is a YAML file that describes services. Render creates them from the Dashboard. You get a public HTTPS address, a Postgres database, and a disk that keeps Cuttlely's files across deploys. People sign in with WorkOS.

Use Render when a team needs one shared Cuttlely on the internet. On your own computer, use [Docker](./docker.md) or [From source](./from-source.md). Both stay on SQLite.

These steps were checked against [`render.yaml`](../../render.yaml) and Render's documentation. No deploy was made for this guide, so there are no screenshots of the Dashboard.

## What the Blueprint creates

| Resource               | Value in `render.yaml`                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web service `cuttlely` | `runtime: docker`, built from the root `Dockerfile` (Node 24, Chromium, the agent runtime). It starts `scripts/start-cuttlely.sh`.                                                                                                                                                                                                                                       |
| Web plan               | `pro plus`: 8 GB of RAM and 4 CPUs. The agent runtime, Chromium, and Node share it. `pro` (4 GB, 2 CPUs) is the minimum, and `pro max` is the next step up.                                                                                                                                                                                                              |
| Instances              | `numInstances: 1`. A service with a disk can't be scaled out.                                                                                                                                                                                                                                                                                                            |
| Disk `cuttlely-data`   | 10 GB at `/var/cuttlely`. It can grow later and can't shrink.                                                                                                                                                                                                                                                                                                            |
| Health check           | `GET /api/v1/ping`. It answers `503` while the boot profile compile is still the startup gate, and while the database can't be reached, so a deploy does not go live in the middle of that compile or without its database. A compile that runs past a few minutes continues in the background; ping can then answer `200` while chat and prediction still answer `503`. |
| Deploys                | `autoDeployTrigger: commit` on branch `main`: every push to `main` deploys.                                                                                                                                                                                                                                                                                              |
| Database `cuttlely-db` | Postgres 16, plan `basic-1gb`, database and user `cuttlely`                                                                                                                                                                                                                                                                                                              |
| Region                 | `oregon` for both, so the service reaches the database on Render's internal network                                                                                                                                                                                                                                                                                      |
| Preview environments   | Off (`previews.generation: off`)                                                                                                                                                                                                                                                                                                                                         |

The repository never calls the Render API. You apply the Blueprint in the Dashboard yourself.

## Before you start

-   A Render workspace that can create paid services. The web plan, the disk, and the database plan are all paid. Disks aren't available on the free plan.
-   Access to this repository from Render, through your Git provider.
-   A WorkOS AuthKit application. The values you need are in [WorkOS AuthKit setup](../identity/workos-authkit-setup.md). The redirect URIs come after the deploy, when you know the service's address.
-   The email of the first owner. It goes in `CUTTLELY_BOOTSTRAP_EMAIL`.

## Apply the Blueprint

1. In the Render Dashboard, select **New** > **Blueprint**.
2. Select **Connect** next to this repository.
3. Give the Blueprint a name and select the `main` branch. Leave **Blueprint Path** empty, so Render uses `render.yaml` at the repository root.
4. Render asks for a value for each variable marked `sync: false`:

    | Variable                   | Value                                                                                                             |
    | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
    | `WORKOS_API_KEY`           | From WorkOS.                                                                                                      |
    | `WORKOS_CLIENT_ID`         | From WorkOS.                                                                                                      |
    | `WORKOS_REDIRECT_URI`      | `https://<your-service>.onrender.com/api/v1/auth/callback`. Fix it after the first deploy if the address differs. |
    | `WORKOS_COOKIE_PASSWORD`   | A random value of at least 32 characters for the AuthKit setup test. Current sessions use the database.           |
    | `CUTTLELY_BOOTSTRAP_EMAIL` | The verified email of the first owner.                                                                            |

    Render asks only now, when the Blueprint is created. Later Blueprint syncs ignore `sync: false` variables. To change one, edit it on the service's **Environment** page.

    Don't have the WorkOS values yet? Leave them empty. The first start prints a one-time setup link in the service's **Logs**; open it to create the owner with a password or to set up AuthKit from the browser. See [When nobody can sign in yet](./sign-in.md#when-nobody-can-sign-in-yet).

5. Review the list of resources, then select **Deploy Blueprint**.

Render creates the database, the disk, and the service, then builds the image. The service is live when the health check passes. Render shows the address on the service page, for example `https://your-service.onrender.com`.

## Point WorkOS at the service

In WorkOS, set these URIs to the service's real address:

| WorkOS field       | Value                                                    |
| ------------------ | -------------------------------------------------------- |
| Redirect URI       | `https://your-service.onrender.com/api/v1/auth/callback` |
| Sign-out URI       | `https://your-service.onrender.com/signin`               |
| Initiate login URI | `https://your-service.onrender.com/api/v1/auth/login`    |

`WORKOS_REDIRECT_URI` on the service must match the redirect URI exactly. After you change it on the **Environment** page, save and redeploy the service.

## First sign-in

1. Open `https://your-service.onrender.com/signin`. The page shows **Sign in with WorkOS**.
2. Sign in with the email in `CUTTLELY_BOOTSTRAP_EMAIL`. You become the owner.
3. Add other people under **Admin** > **Users**, then send each person the one-time invite link **Add User** shows. They join only through that link. See [Invite people](./sign-in.md#invite-people).

`CUTTLELY_LOCAL_ADMIN` isn't in `render.yaml`, so the password form is off. See [Recover access](#recover-access).

Model keys are not environment variables here. The Blueprint has no `OPENAI_API_KEY` or `XAI_API_KEY`. Save keys under **Credentials** in the app.

## Settings in the Blueprint

The app database is Postgres. Cuttlely does not read `DATABASE_URL`. It reads the separate `DATABASE_*` variables, which the Blueprint fills from `cuttlely-db`.

| Variable                               | Blueprint value             | Notes                                                                                                                                                            |
| -------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                 | set by Render               | Don't set it in the file.                                                                                                                                        |
| `HOST`                                 | `0.0.0.0`                   |                                                                                                                                                                  |
| `NODE_OPTIONS`                         | `--max-old-space-size=4096` | The runtime heap. The image build uses a larger heap.                                                                                                            |
| `DATABASE_TYPE`                        | `postgres`                  |                                                                                                                                                                  |
| `DATABASE_HOST`                        | from `cuttlely-db`          | The internal host.                                                                                                                                               |
| `DATABASE_PORT`                        | from `cuttlely-db`          | The server's default is `5432` when it's unset.                                                                                                                  |
| `DATABASE_NAME`                        | from `cuttlely-db`          |                                                                                                                                                                  |
| `DATABASE_USER`                        | from `cuttlely-db`          |                                                                                                                                                                  |
| `DATABASE_PASSWORD`                    | from `cuttlely-db`          |                                                                                                                                                                  |
| `DATABASE_SSL`                         | `false`                     | The internal host doesn't use TLS. An external address would need `true`.                                                                                        |
| `DATABASE_PATH`                        | `/var/cuttlely/data`        | A directory. App rows are in Postgres. The key files live here.                                                                                                  |
| `SECRETKEY_PATH`                       | `/var/cuttlely/data`        |                                                                                                                                                                  |
| `BLOB_STORAGE_PATH`                    | `/var/cuttlely/storage`     | Uploads.                                                                                                                                                         |
| `STORAGE_TYPE`                         | `local`                     | Files go on the disk.                                                                                                                                            |
| `CUTTLELY_DATA_DIR`                    | `/var/cuttlely`             | Harness records and version history (`/var/cuttlely/versions`).                                                                                                  |
| `CUTTLELY_HERMES_HOME`                 | `/var/cuttlely/hermes`      | `HERMES_HOME` matches it.                                                                                                                                        |
| `CUTTLELY_ETL_DIR`                     | `/var/cuttlely/etl`         | ETL runs, local vector stores, and uploads. See [ETL](./etl.md#settings).                                                                                        |
| `LOG_PATH`                             | `/var/cuttlely/logs`        | Also shown under **Admin** > **Logs** for an owner or a role with `logs:view`. Presets use a range token on the server clock. Redaction runs on the joined text. |
| `TRUST_PROXY`                          | `1`                         | One Render proxy hop.                                                                                                                                            |
| `WORKOS_*`, `CUTTLELY_BOOTSTRAP_EMAIL` | `sync: false`               | Entered when you create the Blueprint.                                                                                                                           |
| `FLOWISE_SECRETKEY_OVERWRITE`          | generated                   | The credential encryption key. Render generates it once and keeps it.                                                                                            |
| `CUTTLELY_ANALYST`                     | not set                     | See [Analyst database](#analyst-database).                                                                                                                       |
| `CUTTLELY_POSTGRES_URL`                | not set                     | See [Analyst database](#analyst-database).                                                                                                                       |
| `CUTTLELY_LOCAL_ADMIN`                 | not set                     | The password form stays off.                                                                                                                                     |
| `CUTTLELY_VERSIONS`                    | not set                     | Version history is on. Set `off` on the **Environment** page to turn it off.                                                                                     |
| `CUTTLELY_DRAFTS`                      | not set                     | Drafts are on. Set `off` on the **Environment** page to save to Live.                                                                                            |

A Blueprint sync sets every variable that has a value in the file back to that value. Change those in `render.yaml`. Variables the file doesn't list, such as `CUTTLELY_ANALYST`, stay as you set them in the Dashboard.

## Analyst database

Analyst mode is off until you set `CUTTLELY_ANALYST` to `auto` on the service's **Environment** page. The Blueprint leaves that variable and `CUTTLELY_POSTGRES_URL` out on purpose, so a later sync doesn't clear what you set.

With `auto`, Cuttlely creates an `analyst` schema in `cuttlely-db` and a login that can't read the app's tables. The `cuttlely-db` user has to be allowed to create roles, and Render's managed Postgres often doesn't allow it. When it can't, analyst mode stops. It doesn't fall back to the app's login. Then create a separate database and set `CUTTLELY_POSTGRES_URL` to it. Don't use the connection string of `cuttlely-db`: the tool refuses it. If that host requires TLS, add `sslmode` to the URL yourself. Cuttlely doesn't add it.

What auto mode creates, which URL wins, and the canvas steps are in [Analyst mode](./analyst.md).

## Deploys and data

-   Every push to `main` deploys. With a disk attached, Render stops the old instance before it starts the new one, so each deploy has a short outage.
-   Everything Cuttlely writes outside Postgres is on the disk at `/var/cuttlely`: the key files, uploads, harness records, the agent runtime home, ETL files, logs, and version history. Render takes a snapshot of the disk every day, and you can restore one from the service's **Disk** page.
-   Render backs up paid Postgres databases continuously, for point-in-time recovery. The window depends on your workspace plan.
-   Keep `FLOWISE_SECRETKEY_OVERWRITE`. If it changes or is lost, stored credentials can't be read.

## Recover access

When WorkOS sign-in isn't working, use the local account for a while:

1. On the service's **Environment** page, add `CUTTLELY_LOCAL_ADMIN` with the value `true`, save, and redeploy.
2. On the service's **Shell** page, in the app folder `/usr/src/cuttlely`, run `pnpm user --email you@example.com` and type a password. On an empty database this creates the owner. With an existing owner's email, it sets a new password.
3. Sign in at `/signin` with **Sign in with password**.
4. Fix WorkOS, then delete `CUTTLELY_LOCAL_ADMIN` again.

More about the local account: [Sign in](./sign-in.md).

## Troubleshooting

| You see                                                    | What to do                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The health check stays red                                 | Check the service logs. Usually the instance ran out of memory, or Postgres isn't reachable. A browser specialist starts Chromium on the same instance. |
| `Sign-in is not configured.`                               | No account opens `/setup`. The code is the log line `Setup code`. With accounts, set both WorkOS values on **Environment**.                             |
| WorkOS shows a redirect URI error                          | The redirect URI in WorkOS and `WORKOS_REDIRECT_URI` must match exactly, including `https://` and `/api/v1/auth/callback`.                              |
| `First-user setup is not available.`                       | On an empty database, `CUTTLELY_BOOTSTRAP_EMAIL` is unset or doesn't match the email you signed in with. Fix it on the **Environment** page.            |
| A WorkOS variable is empty after you changed the Blueprint | Render asks for `sync: false` values only when the Blueprint is created. Set them on the **Environment** page.                                          |
| A Dashboard change to a variable came back after a sync    | The variable has a value in `render.yaml`, and the sync set it back. Change it in the file.                                                             |
| Analyst mode stops with a role error                       | `cuttlely-db` can't create roles. Set `CUTTLELY_POSTGRES_URL` to a separate database. See [Analyst database](#analyst-database).                        |
| Stored credentials stop working                            | `FLOWISE_SECRETKEY_OVERWRITE` changed. Put the original value back.                                                                                     |

WorkOS setup field by field: [WorkOS AuthKit setup](../identity/workos-authkit-setup.md).
