# cuttlely

Start [Cuttlely](https://cuttlely.com) in Docker. Cuttlely is the open-source agent platform for applications.

The full server needs the Python agent runtime that ships in the Docker image, so this package does not install the server. `npx cuttlely` pulls `ghcr.io/cuttlely/cuttlely` and runs it.

Requires Node.js 20 or newer, and Docker.

## Start

```bash
npx cuttlely start
```

That pulls `ghcr.io/cuttlely/cuttlely:1.0.0` (the same version as this package), keeps data in the Docker volume `cuttlely-data`, publishes port **43117**, waits until `http://127.0.0.1:43117/api/v1/ping` answers `pong`, prints `http://localhost:43117`, and opens it.

```bash
npx cuttlely start --port 8080 --tag 1.0.0 --env-file .env --no-open
```

| Flag         | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `--port`     | Host and container port. Default `43117`.                                |
| `--tag`      | Image tag. Default is this package's version. `latest` is allowed.       |
| `--env-file` | Passed through to `docker run`. The port and data paths above still win. |
| `--no-open`  | Print the URL and skip the browser.                                      |

A global install works the same way: `npm install -g cuttlely`, then `cuttlely start`.

If Docker is missing or not running, the command says so and links to the [install guide](https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/docker.md).

## Other commands

```bash
cuttlely stop      # stop the container; running answers get up to 35 seconds to finish
cuttlely status
cuttlely logs
cuttlely logs --follow
cuttlely upgrade   # pull the image and start it again
cuttlely --help
cuttlely --version
```

## Check a draft

`check` runs the Publish check on a flow's draft and waits for it. It reads the API key from `CUTTLELY_API_KEY` and calls the server you name. It does not start Docker.

```bash
export CUTTLELY_API_KEY=<key>
npx cuttlely check --flow <flow id> --server http://127.0.0.1:43117 --timeout 300 --json check.json --fail-on-changed
```

| Flag                | Meaning                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `--flow`            | Flow id from the canvas address bar. Required.                                                            |
| `--server`          | Server origin. Default `http://127.0.0.1:43117`.                                                          |
| `--timeout`         | Seconds to wait. Default 300.                                                                             |
| `--json`            | Write the full check JSON to this path.                                                                   |
| `--fail-on-changed` | Exit 1 when any answer is Changed. Without it, a finished check exits 0 and the summary still lists them. |

`pnpm dev` serves the API on port 3000. `scripts/start-cuttlely.sh` and `npx cuttlely start` listen on port 43117.

| Code | When                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The check finished. No answer was Changed, or `--fail-on-changed` was off.                                                               |
| 1    | `--fail-on-changed` was set and at least one answer was Changed.                                                                         |
| 2    | The check timed out, the server returned an error, `CUTTLELY_API_KEY` was missing, the flow has no draft, or the command was used wrong. |

A check the server marks stopped or failed also exits 2. If the draft is saved, published, or discarded while the check runs, the command exits 2, because the answers may be for a draft that is already gone. After the check has started, a timeout, a 403, or any other failure asks the server to stop it. That stop is best effort: if it fails, the exit code is still 2.

The key needs both permissions for the flow: `chatflows:view` and `chatflows:update`, or `agentflows:view` and `agentflows:update`. Update starts the check. View is what reading the result uses. The guide is [Fail a build when answers change](https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/ci-gate.md).

The container name is `cuttlely`. `start` leaves it running when it is already on the same image and port. `upgrade` always pulls and starts it again. The volume is `cuttlely-data`, mounted at `/var/cuttlely`.

Compose uses the volume name `cuttlely_cuttlely-data`. This launcher uses `cuttlely-data`.

The first account is created from the one-time setup link in `cuttlely logs`.

The start, stop, status, logs and upgrade commands make no network call of their own. Docker pulls the image, and start waits on the local health check. `check` calls the Cuttlely server named with `--server`.
