# History API

These routes read a flow's version history, restore a version, keep a [copy in GitHub](#copy-to-github), and [promote a flow from Dev to Prod](#promote-from-dev-to-prod). The app uses them for **Version history**, the version page, the **Version History** settings page and the **From Dev** page. Drafts, Publish, Roll back and the behavior check before Publish are in the [Drafts API](./drafts-api.md). How to use all of it from the app: [Version history](../how-to/versioning.md), starting with [the lifecycle at a glance](../how-to/versioning.md#the-lifecycle-at-a-glance).

All routes are under `/api/v1/flow-versions`. A signed-in session works, and so does an API key with the permissions below. With an API key, the workspace is the key's workspace.

The flow must be in the caller's active workspace. Any other flow id returns 404. A version id (`:sha`) is 7 to 40 lowercase hex characters, a full or short Git commit id. Anything else returns 400.

| Method | Route                       | Permission                                                                                |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------- |
| `GET`  | `/status`                   | `chatflows:view` or `agentflows:view`                                                     |
| `GET`  | `/:chatflowId`              | `chatflows:view` or `agentflows:view`                                                     |
| `GET`  | `/:chatflowId/:sha`         | `chatflows:view` or `agentflows:view`                                                     |
| `GET`  | `/:chatflowId/:sha/diff`    | `chatflows:view` or `agentflows:view`                                                     |
| `POST` | `/:chatflowId/:sha/restore` | `chatflows:update` or `agentflows:update`, then the update permission for the flow's type |

The [GitHub routes](#copy-to-github) and the [promote routes](#promote-from-dev-to-prod) are for the organization owner only.

## Status

`GET /api/v1/flow-versions/status`

```json
{ "enabled": true }
```

`enabled` is `false` when `CUTTLELY_VERSIONS` turns history off. See [History settings](./versioning-settings.md).

## List versions

`GET /api/v1/flow-versions/:chatflowId`

Returns the flow's newest 200 versions, newest first.

```json
{
    "enabled": true,
    "versions": [
        {
            "sha": "3413dc1a…",
            "shortSha": "3413dc1",
            "date": "2026-10-08T04:19:12-05:00",
            "author": "Alex Rivera",
            "authorId": "<user id>",
            "authorKind": "user",
            "title": "Changed System Message on Conversation Chain",
            "details": [],
            "kind": "save",
            "name": "Bakery helper",
            "hiddenSecrets": 0,
            "published": false
        }
    ],
    "lastError": null,
    "liveSha": "3413dc1a…",
    "lastPublished": null
}
```

| Field           | Meaning                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sha`           | Full commit id. Use it, or its first 7 characters, as `:sha`.                                                                                     |
| `date`          | When it was saved, ISO 8601 with the server's UTC offset.                                                                                         |
| `author`        | Display name of the person who saved it, or `cuttlely` for an API key or system save.                                                             |
| `authorId`      | That person's user id. `null` for an API key or system save.                                                                                      |
| `authorKind`    | `user` or `system`.                                                                                                                               |
| `title`         | The version name Cuttlely wrote from the change.                                                                                                  |
| `details`       | More lines about the change. Can be empty.                                                                                                        |
| `kind`          | `create`, `save`, `restore`, `publish`, `rollback`, `promote`, or `delete`. `unknown` for a commit Cuttlely did not write.                        |
| `promotedFrom`  | For a `promote` version, the full id of the version from Dev it copies. Otherwise `null`.                                                         |
| `name`          | The flow's name in that version.                                                                                                                  |
| `hiddenSecrets` | How many secret-looking values this version holds as `[secret hidden]`. `0` when none.                                                            |
| `published`     | `true` for a version put Live by Publish, Roll back Live or Promote (kind `publish`, `rollback` or `promote`). See [Drafts API](./drafts-api.md). |

`lastError` is the reason a save of this flow could not be added to history, when the server's most recent history failure since it started was for this flow. Otherwise it is `null`. A later successful save does not clear it, so a version list can have both a recorded latest version and a `lastError`. It clears when the server restarts or a save of another flow fails.

`liveSha` is the version that is Live now: the newest version, when the flow has not changed since it was recorded. It is `null` when there are no versions, the newest version has another flow type or category, or the latest change to the flow could not be added to history. The flow is compared the way history stores it, so values history never keeps (passwords, and text hidden as `[secret hidden]`) are not compared: a change to only such a value does not move the marker.

`lastPublished` is the last Publish or Roll back Live, `{ "sha": …, "date": … }`, or `null`. See [Drafts API](./drafts-api.md).

With history off the response is `{ "enabled": false, "versions": [], "lastError": null, "liveSha": null, "lastPublished": null }`.

## Read one version

`GET /api/v1/flow-versions/:chatflowId/:sha`

Returns that version as a canvas you can load.

```json
{
    "sha": "5e45b8a",
    "name": "Bakery helper",
    "type": "CHATFLOW",
    "flowData": "{\"nodes\":[…],\"edges\":[…]}",
    "missingCredentials": [{ "name": "OpenAI trial", "credentialName": "openAIApi" }],
    "ambiguousCredentials": [{ "name": "OpenAI main", "credentialName": "openAIApi", "count": 2, "using": "current" }],
    "hiddenSecrets": [
        {
            "node": "conversationChain_0",
            "label": "Conversation Chain",
            "input": "systemMessagePrompt",
            "inputLabel": "System Message",
            "count": 1
        }
    ]
}
```

`flowData` is a JSON string, the same shape as a chatflow's `flowData`. Credentials are mapped by name and type to credentials in the caller's workspace. Fields that are never stored, such as passwords, are filled from the flow as it is now. Secret-looking text that was hidden stays `[secret hidden]`. See [What is stored, and what is not](../how-to/versioning.md#what-is-stored-and-what-is-not).

| Field                  | Meaning                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missingCredentials`   | Credentials this version names that the workspace does not have. Those nodes have no credential selected.                                                                                                                                     |
| `ambiguousCredentials` | Credentials this version names that more than one workspace credential matches. `count` is how many match. `using` is `current` when the one the flow uses now was picked, or `oldest` when none of them is in use and the oldest was picked. |
| `hiddenSecrets`        | Inputs where secret-looking text was hidden when this version was saved: `node` (id), `label` (node label), `input`, `inputLabel`, and `count`. Those inputs hold `[secret hidden]`. Empty when none.                                         |

A version id that is not in this flow's history returns 404 `Version <sha> was not found for this flow.` With history off, every version returns 404.

## Compare

`GET /api/v1/flow-versions/:chatflowId/:sha/diff?against=previous`

Lists what the version `:sha` has compared with another state of the flow.

| `against`    | Compared with                                   |
| ------------ | ----------------------------------------------- |
| `previous`   | This flow's version before `:sha`. The default. |
| `current`    | The flow as it is saved now.                    |
| a version id | That version of this flow.                      |

Any other value returns 400 `against is previous, current, or a version id.`

```json
{
    "sha": "3249e7c",
    "against": "5e45b8a1…",
    "added": [],
    "removed": [],
    "changed": [{ "id": "conversationChain_0", "label": "Conversation Chain", "fields": ["systemMessagePrompt"] }],
    "moved": ["bufferMemory_0", "conversationChain_0"],
    "edgesChanged": false,
    "renamed": null
}
```

| Field          | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `against`      | The commit id compared with, `current`, or `null` when `:sha` is the flow's first version. |
| `added`        | Nodes in `:sha` that are not in the other state.                                           |
| `removed`      | Nodes in the other state that are not in `:sha`.                                           |
| `changed`      | Nodes in both whose settings differ. `fields` are input names, or the setting's key.       |
| `moved`        | Ids of nodes whose position differs.                                                       |
| `edgesChanged` | `true` when the connections differ. Connections are compared by their ends.                |
| `renamed`      | `{ "from": …, "to": … }` when the flow's name differs, else `null`.                        |

A field that is never stored, such as a password, never shows as a change. With `current`, secret-looking text in the flow now is hidden the same way before comparing, so a hidden value does not show as a change.

## Restore

`POST /api/v1/flow-versions/:chatflowId/:sha/restore`

No body. Saves version `:sha` as the flow's live canvas, with its name, type and category, through the normal chatflow update. When the flow saves to a draft (see [Drafts API](./drafts-api.md)), the version becomes the draft instead, as described [below](#restore-when-the-flow-saves-to-a-draft). The caller needs the update permission for the flow's type and for the version's type: `chatflows:update` for a chatflow, `agentflows:update` for an agentflow, `assistants:update` for an assistant.

The save is recorded as a new version of kind `restore`, titled `Restored: <title> (<short sha>)`, with the caller as its author. An API key's restore is recorded as `cuttlely`.

```json
{
    "chatflow": { "id": "<flow id>", "name": "Bakery helper", "type": "CHATFLOW", "updatedDate": "2026-10-08T09:21:40.000Z" },
    "restoredFrom": "5e45b8a",
    "restoredTo": "live",
    "version": {
        "sha": "afc07f3…",
        "kind": "restore",
        "title": "Restored: Changed credential, Temperature on ChatOpenAI (5e45b8a)",
        "…": "…"
    },
    "unchanged": false,
    "recorded": true,
    "historyError": null,
    "missingCredentials": [],
    "ambiguousCredentials": [],
    "hiddenSecrets": []
}
```

| Field                  | Meaning                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatflow`             | The flow after the restore. Load the flow again for its `flowData`.                                                                                                                                                        |
| `restoredTo`           | `live`, or `draft` when the flow saves to a draft (see below).                                                                                                                                                             |
| `version`              | The new history entry, in the list format. `null` when nothing was recorded.                                                                                                                                               |
| `unchanged`            | `true` when the flow already matched the version, including the inputs the version holds as `[secret hidden]`. Nothing is saved and `version` is `null`.                                                                   |
| `recorded`             | `true` when the restore was added to history as a new version. `false` when nothing was added: either the flow already matched (`unchanged: true`, `historyError: null`) or the history write failed (`unchanged: false`). |
| `historyError`         | Why the history write failed, when `unchanged` is `false`, `recorded` is `false`, and the reason is known. Otherwise `null`.                                                                                               |
| `missingCredentials`   | As in [Read one version](#read-one-version). Those nodes are saved with no credential selected.                                                                                                                            |
| `hiddenSecrets`        | As in [Read one version](#read-one-version). Those inputs are saved with `[secret hidden]`. Replace it before you run the flow.                                                                                            |
| `ambiguousCredentials` | As in [Read one version](#read-one-version).                                                                                                                                                                               |

| Status | When                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 403    | `You do not have permission to change this type of flow.`                                                                                                                                 |
| 404    | The flow is not in the caller's workspace, or the version is not found.                                                                                                                   |
| 409    | `Version history is off on this server.` A Live update that lands after Restore has read the canvas returns `Live changed while this was being saved, so nothing was changed. Try again.` |

### Restore when the flow saves to a draft

With drafts on and the flow in draft mode, Restore puts the version's canvas in the draft and leaves Live alone until Publish. The flow's name, type and category are not changed, because a draft holds the canvas only. Nothing is added to history. To change Live at once, use [Roll back Live](./drafts-api.md#roll-back-live).

The response has `restoredTo: "draft"`, `draft` (the draft status), `version: null` and `recorded: false`. `unchanged` is `true` when the version matches Live, so there is nothing to publish. A version of another kind of flow returns 409 `This version is a different kind of flow, so it cannot become the draft. Use Roll back Live instead.`

## Copy to GitHub

An owner can connect a GitHub repository so every new version is copied there. In the app this is the GitHub card on **Admin**, then **Version History** (`/version-history`), which only an owner sees. How to set it up, and which token to make: [Keep a copy in GitHub](../how-to/versioning.md#keep-a-copy-in-github). These routes need a signed-in organization owner (Super User). A role grant is not enough, and an API key always gets 403, because the connection is for the whole server.

| Method   | Route               | What it does                                              |
| -------- | ------------------- | --------------------------------------------------------- |
| `GET`    | `/github`           | The connection and copy status                            |
| `PUT`    | `/github`           | Check a repository and token, save them, and start a copy |
| `DELETE` | `/github`           | Forget the repository and token                           |
| `POST`   | `/github/push`      | Copy now instead of waiting for the next try              |
| `POST`   | `/github/repos`     | List the repositories a token can write to                |
| `POST`   | `/github/repos/new` | Create a new private, empty repository                    |
| `PUT`    | `/environment`      | Label this server Dev or Prod                             |

The connect, disconnect, copy and label routes answer with the status. It never holds the token.

```json
{
    "enabled": true,
    "connected": true,
    "credential": { "id": "<credential id>", "name": "GitHub: acme/cuttlely-flows" },
    "repo": "acme/cuttlely-flows",
    "url": "https://github.com/acme/cuttlely-flows",
    "state": "up-to-date",
    "message": "Up to date. Every version on this server is on GitHub.",
    "waiting": 0,
    "lastCopiedAt": "2026-10-08T23:41:05.000Z",
    "lastCopiedVersion": "3413dc1",
    "nextTryAt": null,
    "connectedAt": "2026-10-08T23:40:58.000Z",
    "environment": "dev",
    "environments": [
        { "name": "dev", "branch": "main", "server": "dev" },
        { "name": "prod", "branch": "main", "server": "prod" }
    ],
    "promotes": false,
    "role": "copy",
    "lastCheckedAt": null,
    "incomingVersion": null
}
```

| Field               | Meaning                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `enabled`           | `false` when history is off. Then `state` is `off` and nothing is copied.                                 |
| `credential`        | The **Github API** credential that holds the token: its id and name, never the token.                     |
| `state`             | One of the states below.                                                                                  |
| `message`           | One plain sentence for the screen.                                                                        |
| `waiting`           | Versions on this server that are not on GitHub yet. `null` when it cannot be counted.                     |
| `lastCopiedAt`      | When the last copy finished, since the server started. `null` before the first copy.                      |
| `lastCopiedVersion` | The short id of the newest version on GitHub after that copy.                                             |
| `nextTryAt`         | When Cuttlely tries again after a failure, while `state` is `retrying`.                                   |
| `environment`       | This server's identity in `environments`: `dev`, `prod`, another server identity, or `null`.              |
| `environments`      | Promotion order. A saved Dev or Prod label with no list is dev, then prod.                                |
| `promotes`          | `true` when this server promotes from the previous environment.                                           |
| `role`              | `copy` when this server publishes versions. `read` on the last environment: it only reads the repository. |
| `lastCheckedAt`     | Prod: when it last looked for new versions from Dev. `null` on Dev.                                       |
| `incomingVersion`   | Prod: the short id of the newest version it found there. `null` on Dev or when empty.                     |

| `state`         | Meaning                                                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-connected` | No repository. History stays on the server.                                                                                                                                                                                                                    |
| `up-to-date`    | Every version is on GitHub.                                                                                                                                                                                                                                    |
| `waiting`       | New versions are queued and are copied in a few seconds.                                                                                                                                                                                                       |
| `copying`       | A copy is running.                                                                                                                                                                                                                                             |
| `retrying`      | GitHub could not be reached, refused the token, or the copy failed for another reason. Cuttlely tries again on its own, waiting longer each time, up to 15 minutes.                                                                                            |
| `stopped`       | Copying needs you. The branch this server publishes to has commits this server does not have, a branch rule or ruleset on GitHub refuses the copy, a version holds secret-shaped text, or the GitHub credential was deleted or is empty. `message` says which. |
| `off`           | History is off on this server.                                                                                                                                                                                                                                 |

### Connect

`PUT /api/v1/flow-versions/github`

```json
{ "repo": "acme/cuttlely-flows", "token": "<fine-grained token>", "credentialName": "GitHub: acme/cuttlely-flows" }
```

The token needs only **Contents** set to **Read and write** on that one repository (**Read-only** on a Prod server). GitHub adds **Metadata** read-only on its own. See [Which GitHub token to use](../how-to/versioning.md#which-github-token-to-use).

Or use a **Github API** credential already in the caller's workspace instead of pasting a token:

```json
{ "repo": "acme/cuttlely-flows", "credentialId": "<credential id>" }
```

`repo` is `owner/name` or the repository's `https://github.com/owner/name` address. Cuttlely first asks GitHub for the repository's branches and tags with that token. Nothing is saved unless that works. With the saved Dev and Prod pair, the repository must be empty (no branches or tags at all), or have a `main` that is already part of this server's history (for example, one this server copied to before). A repository with a `master` or any other branch, or a tag, but no `main` is refused. With a named list, the check is this server's own publish branch: that branch must be absent, or already part of this server's history. Other environments' branches may already be in the repository. A read-only server (the last in the list) does not need `main` and does not need its own publish branch. Then a pasted token is saved as a new **Github API** credential in the caller's workspace, named `credentialName` or `GitHub: <owner/name>`, and Cuttlely saves the connection and copies every version. A token that fails the check is never saved.

| Status | When                                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | The repository or token is not valid, GitHub did not accept the token, the repository is not there, or GitHub could not be reached. The message says which. Nothing is saved.                                                                                                           |
| 409    | History is off, or the repository already has other content. For the saved pair that is a `main` this server did not write, or other branches or tags and no `main`. For a named list it is this server's publish branch when that branch is not already part of this server's history. |

### Disconnect

`DELETE /api/v1/flow-versions/github`

Cuttlely forgets the repository. Nothing on GitHub changes. The **Github API** credential stays on the Credentials page; delete it there if nothing else uses it.

### Copy now

`POST /api/v1/flow-versions/github/push`

No body. Copies at once, and answers when the copy is done or has failed. 409 `GitHub is not connected.` when there is no connection.

### List repositories

`POST /api/v1/flow-versions/github/repos`

```json
{ "token": "<token>" }
```

or `{ "credentialId": "<credential id>" }`. Asks GitHub which repositories the token can write to, most recently changed first, so the app can offer a list instead of a typed address. It reads up to 1,000 repositories. Archived repositories are left out. Nothing is saved.

```json
{
    "account": "acme-bot",
    "repos": [{ "repo": "acme/cuttlely-flows", "private": true, "empty": true, "pushedAt": null }]
}
```

`empty` is `true` when GitHub reports no content. Only an empty repository, or one this server copied to before, can be connected. A token GitHub refuses, or GitHub out of reach, is 400 with a plain message.

### Create a repository

`POST /api/v1/flow-versions/github/repos/new`

```json
{ "token": "<token>", "name": "cuttlely-flows" }
```

`credentialId` works here too.

Creates a private, empty repository with that name in the token's account and answers with it, in the list format. Connect it next. A fine-grained token can create repositories only with **Administration** set to **Read and write** for all repositories, so most fine-grained tokens get 400 `This token cannot create repositories…`; create the repository on GitHub instead. A name that is taken is 409.

### Label this server

`PUT /api/v1/flow-versions/environment`

```json
{ "environment": "prod" }
```

`dev`, `prod`, or `null` to clear it. That is the saved pair: dev, then prod. It is kept in the history repo's `.git` folder, not in a version, and an existing file with only `environment` still loads as that pair.

To put another environment between them, send the ordered list. Each entry has a `name` (shown in the app), a `branch` (where that environment publishes), and a `server` (the identity `environment` matches). Names, server identities and branches have to be different. The saved pair is the one exception: both branches stay `main`.

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

`environment` has to be one of the `server` values, or `null`. Sending `environment` alone later picks another server in the list that is already saved. A server that is not in the list is 400.

The first environment copies its versions to its branch. Each later one reads the previous environment's branch and can promote from it. The last environment only reads. One in the middle reads the previous branch and copies its own published versions, including promotions, to its own branch, so the next environment can read them. Promotion does not skip: Dev to Prod is refused while Staging is between them. On every hop the behavior check and the credential-name check still run.

Switching this server, or saving a list that changes what it reads or copies, while a repository is connected is 409; disconnect first. Nothing on GitHub changes either way. A saved Dev or Prod label with no list behaves as before: Dev copies to `main`, and Prod reads `main`.

### How copying works

-   A new version, from a save, Publish, Roll back, restore or delete, is copied a few seconds after it is recorded. Drafts are not versions, so they are not copied.
-   Copying runs in the background. It never slows down or fails a save, Publish or Roll back.
-   Cuttlely pushes this server's `main` to the repository branch for this environment. With the saved Dev and Prod pair, that branch is `main`. With a longer list, each environment that publishes uses its own branch. It never force-pushes. When that branch on GitHub has changes this server does not have, copying stops with `state: "stopped"` and GitHub keeps its changes.
-   Before each copy, the versions being copied, their files and their titles, are checked again for key-shaped text, with the same patterns as a commit (see [Version files](./version-files.md#markers)). A hit stops the copy and names the version and pattern, never the text.
-   The token is a **Github API** credential, encrypted like every credential. Change it on the Credentials page and the next copy uses the new one. The connection itself (repository, its address, credential id and name) is a file in the history repo's `.git` folder, outside the files Git tracks, so it is never in a version. The token reaches Git only in the environment of the copy, as an HTTP header for that repository. It is not written into the repo's settings, a remote address, a command line, or the logs.
-   Flow credentials are never copied. Each version names the credentials a flow uses by name and type, as in [Version files](./version-files.md), so another server can match them to its own Credentials by name.
-   Cuttlely does not add a remote to the history repo. It keeps the last copied version in the ref `refs/versions/github`.
-   With that copy, the publishing server records a fingerprint of its environment list. The copy is not finished until that fingerprint is on the repository. The publisher brings in any fingerprint already recorded and retries when another server records one at the same time. If the fingerprint cannot be recorded, the copy stays unfinished. A reading server offers new versions only when it read a fingerprint and that fingerprint matches its own list. When a fingerprint record already exists and this version has none, or the record cannot be read, nothing new is offered. The only read that still accepts versions with no fingerprint is a repository that has no fingerprint record at all.

### How Prod reads

-   Prod connects to the repository the previous environment copies to, with the same `PUT /github`. With the saved Dev and Prod pair, an empty repository is fine (Dev has not copied yet), and a repository with other content and no `main` is refused. With a named list, connect checks this server's own publish branch. A read-only server does not need `main`. The token needs **Contents: Read** only.
-   Every two minutes, and on `POST /github/push` (**Try again**), Prod reads the previous environment's branch into the ref `refs/versions/incoming`. With the saved Dev and Prod pair, that branch is `main`. It changes nothing else: not its own history, not a flow, not a draft, not Live. A failed read retries like a failed copy and never affects Live flows. New versions are installed only when the fingerprint on that version matches this server's list. A different list, a missing fingerprint while some fingerprint is already recorded, or a failure to read the record leaves the previous versions in place and offers nothing new. A repository with no fingerprint record at all is the one case that still installs the versions.
-   Disconnecting forgets `refs/versions/incoming` too.

## Promote from Dev to Prod

On a server that has a previous environment (Prod, in the saved pair), these routes list the flows with a new version from that environment, show one with what it changes and the credentials it needs, run the behavior check against Live, and promote it. Promotion moves only to the next environment. How to use it from the app: [Move a flow from Dev to Prod](../how-to/versioning.md#move-a-flow-from-dev-to-prod). They need a signed-in organization owner, like the GitHub routes. On the first environment the list is empty and Promote is 409. Staging, and any environment that is not first, may promote from the previous one.

The list also returns `environments` (the order), `source` (the previous server identity) and `target` (this server). A saved Dev and Prod label returns dev, then prod, with `source` `dev`.

`POST /incoming/:chatflowId/promote` accepts an optional `from`, the previous server identity. A `from` that is not the previous environment is 409 `Promotion only moves to the next environment.` Omitting `from` promotes from the previous environment, as the app does.

| Method   | Route                                  | What it does                                                   |
| -------- | -------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/incoming`                            | Flows in this workspace with a new version from Dev            |
| `GET`    | `/incoming/:chatflowId`                | That flow's new version: changes, credentials, check readiness |
| `POST`   | `/incoming/:chatflowId/promote`        | Put that version Live here                                     |
| `GET`    | `/incoming/:chatflowId/check`          | Behavior check setup: recent questions, risky steps, last run  |
| `POST`   | `/incoming/:chatflowId/check`          | Start the behavior check                                       |
| `GET`    | `/incoming/:chatflowId/check/:checkId` | Check progress and answers                                     |
| `DELETE` | `/incoming/:chatflowId/check/:checkId` | Stop the check                                                 |

### List

`GET /api/v1/flow-versions/incoming`

```json
{
    "enabled": true,
    "connected": true,
    "lastCheckedAt": "2026-10-08T23:52:10.000Z",
    "flows": [
        {
            "flowId": "4b6f0c2e-…",
            "name": "Bakery helper",
            "type": "CHATFLOW",
            "status": "update",
            "version": {
                "sha": "<40 hex>",
                "shortSha": "3413dc1",
                "date": "…",
                "author": "Dana",
                "title": "Published: Changed instructions"
            },
            "changes": [
                { "sha": "<40 hex>", "shortSha": "3413dc1", "date": "…", "author": "Dana", "title": "Published: Changed instructions" }
            ],
            "moreChanges": false,
            "hasDraft": false,
            "lastPromoted": { "sha": "<40 hex>", "date": "…" }
        }
    ]
}
```

-   One entry per flow: the newest version Dev published. `status` is `update` for a flow this server has, `new` for one it does not have yet.
-   `changes` lists what Dev published since the version last promoted here, newest first, at most 20 (`moreChanges` says when there are more).
-   A flow is left out when its newest version was already promoted, when Live already matches it, when Dev deleted it, or when a flow with that id is in another workspace here.
-   `hasDraft`: this server has unpublished changes for the flow. Promote keeps them (see below).

### One flow

`GET /api/v1/flow-versions/incoming/:chatflowId` answers with the list entry plus:

| Field                  | Meaning                                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diff`                 | What Promote changes compared with Live here, as in [Compare](#compare). For a new flow every node is added.                                                                                                                                                                                        |
| `missingCredentials`   | Credentials the version uses, by name and type, that this workspace does not have. Promote is refused until they are added on the Credentials page.                                                                                                                                                 |
| `ambiguousCredentials` | Names that match more than one credential here, and which one is used, as in [Read one version](#read-one-version).                                                                                                                                                                                 |
| `hiddenSecrets`        | How many inputs hold a hidden-secret placeholder. Values Live has here for the same inputs are kept.                                                                                                                                                                                                |
| `checkUnavailable`     | `null` when the behavior check can run. Otherwise `code` is `new-flow` (no Live to compare with), `type` (not a chatflow or an agentflow, or Live and the version from Dev are different kinds), `start` (an agentflow that does not start with a chat message) or `credentials`, with a `message`. |

404 when the flow has no new version from Dev.

### Promote

`POST /api/v1/flow-versions/incoming/:chatflowId/promote`

```json
{ "sha": "<40 hex>" }
```

`sha` is the full id of the version from the list. Cuttlely checks again that it is still the newest version from Dev for this flow and that every credential it uses is here, then puts it Live through the normal update path, as Roll back does. The answer has the shape of [Restore](#restore), plus `created` and `hasDraft`.

-   History gets a version titled `Promoted from Dev: <title on Dev> (<short id>)`, of kind `promote`, published, with the trailer `Version-From: <full id>` (see [Version files](./version-files.md#commits)). **Roll back** undoes it like any Publish.
-   A flow this server does not have is created with the id it has on Dev, in the caller's workspace, so the next versions from Dev find it.
-   Credentials are matched by name and type in the caller's workspace. Values never travel: Dev's files hold names only.
-   A draft here is kept, unchanged, and stays marked as started from the old Live, so **Publish** asks before replacing what was promoted.
-   Nothing is ever promoted on its own.

| Status | When                                                                                                                                                                                                                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `sha` is not 40 lowercase hex characters.                                                                                                                                                                                                                                                                                                                        |
| 409    | A newer version arrived, the version is no longer offered, a credential is missing (the message lists each one), this server is the first environment (it publishes and does not promote), or `from` is not the previous environment. Staging may promote. With the saved pair, the first environment is Dev and the message still says this server is not Prod. |

### Behavior check

The check routes work like the publish check in the [Drafts API](./drafts-api.md), with the version from Dev in place of the draft: recent questions from this server's chats are replayed against Live and the version from Dev, mapped to this server's credentials. The same `count` chooses how many, from 1 to 100. It writes nothing. It is a separate check from a draft check of the same flow.
