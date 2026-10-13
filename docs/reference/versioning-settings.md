# History settings

Version history and drafts read these environment variables when the server starts. How to use history: [Version history](../how-to/versioning.md).

| Variable                     | Default                                  | Notes                                                                                                                    |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `CUTTLELY_VERSIONS`          | unset, history on                        | `off`, `false`, `0`, or `no` turns history off. Case and surrounding spaces do not matter. Any other value leaves it on. |
| `CUTTLELY_DRAFTS`            | unset, drafts on                         | `off`, `false`, `0`, or `no` turns drafts off. Case and surrounding spaces do not matter. Other values leave them on.    |
| `CUTTLELY_CHECK_MAX_TOKENS`  | `100000`                                 | Most tokens one publish check may use, Live and draft together. 1,000 to 2,000,000.                                      |
| `CUTTLELY_CHECK_MAX_SECONDS` | `180`                                    | Most seconds one publish check may run. 10 to 1,800.                                                                     |
| `CUTTLELY_CHECK_CONCURRENCY` | `2`                                      | How many questions one publish check runs at the same time. 1 to 8.                                                      |
| `CUTTLELY_VERSIONS_DIR`      | unset                                    | The folder for the history repo. A relative path is resolved from the server's working directory.                        |
| `CUTTLELY_DATA_DIR`          | `~/.cuttlely`, or as the install sets it | With `CUTTLELY_VERSIONS_DIR` unset, history is `$CUTTLELY_DATA_DIR/versions`.                                            |

## CUTTLELY_VERSIONS

History is on unless this variable turns it off. With it off:

-   Saves, restores, and deletes are not recorded.
-   The canvas does not show **Version history** or **Last edited by**.
-   `GET /api/v1/flow-versions/status` returns `{ "enabled": false }`, the version list is empty, reading or comparing a version returns 404, and a restore returns 409 `Version history is off on this server.` See [History API](./versioning-api.md).
-   The history repo on disk is left as it is.

Turn it back on by removing the variable, or by setting any other value, and restarting. Saves made while history was off are not in it.

Where to set it:

| Install                                 | Set it                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Docker](../how-to/docker.md)           | Add `CUTTLELY_VERSIONS=off` to `.env` next to `docker-compose.yml`, then `docker compose up -d`. Compose passes it to the container. |
| [Render](../how-to/render.md)           | Add `CUTTLELY_VERSIONS` with the value `off` in the Dashboard.                                                                       |
| [From source](../how-to/from-source.md) | `CUTTLELY_VERSIONS=off bash scripts/start-cuttlely.sh`, or export it before you start the server.                                    |

The server's Jest setup sets `CUTTLELY_VERSIONS=off` unless a test sets it, so tests do not write a history repo in your home folder.

## CUTTLELY_DRAFTS

Drafts are on unless this variable turns them off. With them on, a chatflow or agentflow canvas saves to a draft, and the prediction API, embeds, shared links, schedules and webhooks keep running Live until you select **Publish**. See [Drafts and Publish](../how-to/versioning.md#drafts-and-publish). With them off:

-   The canvas saves straight to Live, and Restore puts a version Live at once.
-   The canvas shows no **Draft** label, **Publish** button, or **Publish instantly** setting.
-   `GET /api/v1/flow-drafts/:chatflowId` returns `"enabled": false`, and the other draft routes return 409 `Drafts are off on this server.` See [Drafts API](./drafts-api.md).
-   Drafts already saved are kept in the database. Turn drafts back on and they are there to publish or discard.

Each flow can also skip drafts with **Publish instantly** in its configuration, without changing the server setting.

Where to set it:

| Install                                 | Set it                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Docker](../how-to/docker.md)           | Add `CUTTLELY_DRAFTS=off` to `.env` next to `docker-compose.yml`, then `docker compose up -d`. Compose passes it to the container. |
| [Render](../how-to/render.md)           | Add `CUTTLELY_DRAFTS` with the value `off` in the Dashboard.                                                                       |
| [From source](../how-to/from-source.md) | `CUTTLELY_DRAFTS=off bash scripts/start-cuttlely.sh`, or export it before you start the server.                                    |

## Publish check limits

The [publish check](./drafts-api.md#publish-check) replays recent questions against Live and the draft before Publish, so it uses the flow's model and costs tokens. Three variables cap each check:

-   `CUTTLELY_CHECK_MAX_TOKENS`: the most tokens one check may use, counting Live and the draft together. Default 100,000. Values below 1,000 count as 1,000, and above 2,000,000 as 2,000,000.
-   `CUTTLELY_CHECK_MAX_SECONDS`: the most seconds one check may run. Default 180. Values below 10 count as 10, and above 1,800 as 1,800.
-   `CUTTLELY_CHECK_CONCURRENCY`: how many questions run at the same time. Default 2, from 1 to 8. Above 8 counts as 8. Each question still asks Live and then the draft, one after the other. Questions already started finish when a token or time limit is reached, so a check can go a little past the token cap.

A value that is not a positive number uses the default. When a limit is reached, the check stops starting new questions and shows the answers it has. How to run a check: [Check recent questions before you publish](../how-to/versioning.md#check-recent-questions-before-you-publish). Set them the same way as `CUTTLELY_DRAFTS` above.

## Testing the GitHub copy without GitHub

`CUTTLELY_GITHUB_ALLOW_FILE_REMOTES=on` lets the [GitHub copy](./versioning-api.md#copy-to-github) accept a local bare repository, `file:///absolute/path`, instead of a GitHub repository. It is for testing Cuttlely without a GitHub account. Leave it unset on a real server.

For an end-to-end run of the GitHub card without an account, two more settings work only together with that one:

-   `CUTTLELY_GITHUB_TEST_ROOT=/absolute/folder` makes a repository named `owner/name` the bare repository `/absolute/folder/owner/name.git`.
-   `CUTTLELY_GITHUB_TEST_API=http://127.0.0.1:PORT` sends the repository list and Make a new repository calls to a local stand-in instead of `https://api.github.com`. The stand-in answers `GET /user`, `GET /user/repos` and `POST /user/repos`.

Both are ignored unless `CUTTLELY_GITHUB_ALLOW_FILE_REMOTES=on`. Leave all three unset on a real server. A connection made with the stand-in stops, and is never sent to github.com, if these settings are later removed.

## Where the history repo is

The first of these that applies:

1. `CUTTLELY_VERSIONS_DIR`.
2. `$CUTTLELY_DATA_DIR/versions`.
3. `~/.cuttlely/versions`.

| Install                       | `CUTTLELY_DATA_DIR`                 | History                          |
| ----------------------------- | ----------------------------------- | -------------------------------- |
| Docker (`docker-compose.yml`) | `/var/cuttlely`                     | `/var/cuttlely/versions`         |
| Render (`render.yaml`)        | `/var/cuttlely`                     | `/var/cuttlely/versions`         |
| `scripts/start-cuttlely.sh`   | `.cuttlely` in the repo, unless set | `.cuttlely/versions` in the repo |

The repo is created the first time history is used, by a save or by opening history, with a `README.md` and a first commit, `Start version history`. The server needs `git` on its path. The Docker image includes it.

Moving the repo: stop Cuttlely, move the folder, set `CUTTLELY_VERSIONS_DIR` to the new place, and start Cuttlely. A folder with no repo in it starts a new, empty history on the next save.

The repo layout and commit format are in [Version files](./version-files.md).

## Environments

Promotion walks an ordered list of environments. Each one has:

| Field    | Meaning                                                                                       |
| -------- | --------------------------------------------------------------------------------------------- |
| `name`   | What the promote page shows.                                                                  |
| `branch` | Where that environment publishes in the shared GitHub repository.                             |
| `server` | The identity of the server that fills that place. `environment` on that server is this value. |

The list is not an environment variable. It is saved on each server, with that server's GitHub connection, in that server's history repo, by `PUT /api/v1/flow-versions/environment`. It is not copied to the shared repository. See [Label this server](./versioning-api.md#label-this-server).

After copying stops on a diverged branch, later reads do not push. Try again pushes once. A process restart tries once and stops again if the branch is still diverged.

Every server in the chain should keep the same list. The list is not compared by talking to the other servers. Each server that publishes records a fingerprint of its list with the copy. That copy is not finished until the fingerprint is on the shared repository: the publisher brings in any fingerprint already recorded, adds its own, and retries when another server recorded one at the same time. If the fingerprint still cannot be recorded, the copy stays unfinished and tries again. A server that reads offers new versions only when it read a fingerprint and that fingerprint matches its own list. When they differ, reading stops and nothing new is offered to promote, until this server saves the same list. Versions already offered stay. When a fingerprint record exists and this version has none, or the record cannot be read, reading stops the same way and nothing new is offered. A Prod server whose list was left as only dev then prod does not receive newer versions once any fingerprint is recorded. The one window that still allows a read with no fingerprint is the saved Dev and Prod pair, when the repository has no fingerprint record at all, because no server has recorded one yet. A named list installs a tip only when the note on it matches. A named Prod whose record is missing keeps the versions already offered and offers nothing new. A failure to reach the repository is not that window. Saving a longer list while this server still publishes the same branch rewrites that fingerprint on the versions already copied, so the next environment can read them without a new version. Disconnect GitHub before a change that alters what this server reads or copies, then save the full list again. An unreadable list does not publish or read. Saving it again drops versions that were already offered, clears the stopped message, and can be done without disconnecting. On a named list, connect is refused until this server's environment is chosen, and the card does not count versions as waiting to be copied.

A server that was already labeled Dev or Prod, with no list in that file, loads as dev then prod. Both use the branch `main`. Dev copies there, and Prod reads it. You do not have to migrate that file. Saving `environment` as `dev` or `prod` with no list keeps writing that older file. Saving a longer list writes `environment` and `environments` together, and `environment` still names this server.

Dev, Staging and Prod:

```json
{
    "environment": "staging",
    "environments": [
        { "name": "Dev", "branch": "main", "server": "dev" },
        { "name": "Staging", "branch": "staging", "server": "staging" },
        { "name": "Prod", "branch": "prod", "server": "prod" }
    ]
}
```

Promotion moves only to the next environment: Dev to Staging, then Staging to Prod. Dev to Prod is refused while Staging is between them. Each hop still runs the behavior check and matches credentials by name. With only Dev and Prod, promotion works as before. How to set this up: [Add Staging between Dev and Prod](../how-to/versioning.md#add-staging-between-dev-and-prod).
