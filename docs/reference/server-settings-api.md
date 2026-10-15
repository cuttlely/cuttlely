# Server settings API

How the organization owner reads and changes server settings, including the limits that apply without a restart, and how to read the change history. The page is **Admin** > **Server Settings**. [Server settings](../how-to/server-settings.md) describes that page. This page is the HTTP API.

These routes are for the organization owner only. A workspace owner, a workspace admin, a member, and a user whose active workspace is a different team are refused. An API key is refused. There is one settings file for the install, not one per workspace.

## Who can call it

Every route under `/api/v1/server-settings` uses the same check.

| Status | When                                                                                                                                                          | Body                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 401    | No signed-in session                                                                                                                                          | `{ "message": "Unauthorized" }` |
| 403    | Signed in, but not the organization owner. This includes a workspace admin, a role that was given `server:owner`, a user in another workspace, and an API key | `{ "message": "Forbidden" }`    |

`server:owner` is not a permission a role can store. The check is the organization owner flag.

## Read and save

`GET /api/v1/server-settings` returns the registry, the current value of each setting, and which changes still wait for a restart.

`PUT /api/v1/server-settings` saves a change. The body is `{ "values": { "NAME": "value" } }`. An empty string removes a saved value so the default applies again. The response is the same shape as the GET. A secret is accepted and never returned.

Most saved values still apply at the next start. Four limits apply without a restart. After a successful save of one of those, `running` is the value now in effect and `restart.changed` does not list it.

| Variable                          | Default | Allowed        | What it changes                                                                 |
| --------------------------------- | ------- | -------------- | ------------------------------------------------------------------------------- |
| `CUTTLELY_LOGIN_FAILURE_LIMIT`    | 10      | 3 to 50        | Failed sign-ins in 15 minutes, per client address and per email, before lockout |
| `CUTTLELY_SESSION_IDLE_MINUTES`   | 720     | 15 to 1440     | Minutes a local session can sit unused                                          |
| `CUTTLELY_SESSION_ABSOLUTE_HOURS` | 168     | 1 to 720       | Hours a local session can last, even if it stays in use                         |
| `CUTTLELY_DRAIN_TIMEOUT_MS`       | 25000   | 5000 to 300000 | Milliseconds a shutdown waits for answers already running                       |

Idle time cannot be longer than the absolute lifetime. 1440 minutes is 24 hours, so an absolute lifetime of 1 hour cannot be paired with the longest idle time.

A shorter idle or absolute lifetime applies to local sessions that are already signed in. The check runs on every authenticated request that presents that cookie, not only when the cookie's own expiry passes. A session that has been idle longer than the new idle time, or that is older than the new absolute lifetime, ends on the next request. AuthKit session length stays with WorkOS. An API key is not a session and is not affected.

The process that saved the value uses it on the next read. The HTTP server and a queue worker re-read the settings file at least every 5 seconds, so a worker is at most 5 seconds behind. The shutdown wait is read when a shutdown starts.

### Validation

A failed save writes nothing and appends no history row. The body is `{ "code": "INVALID", "message": "Some settings could not be saved.", "errors": [{ "key": "NAME", "message": "..." }] }` with status 400, unless the table says otherwise.

| Request                                                                                | Status | `code`           |
| -------------------------------------------------------------------------------------- | ------ | ---------------- |
| Value outside the range, not a whole number, or idle longer than the absolute lifetime | 400    | `INVALID`        |
| Unknown name, or a name the page is not allowed to change                              | 400    | `INVALID`        |
| Name set by the host environment                                                       | 400    | `INVALID`        |
| `limit` on the history route is missing or a whole number                              | 200    |                  |
| `limit` is `0`, negative, or not a whole number                                        | 400    | `INVALID`        |
| `cursor` is missing or a cursor from this route                                        | 200    |                  |
| `cursor` is anything else                                                              | 400    | `INVALID_CURSOR` |
| No session                                                                             | 401    |                  |
| Not the organization owner                                                             | 403    |                  |

A host value that is outside the range is not rewritten. Enforcement uses the nearest allowed value, so a host value of `0` for the shutdown wait waits 5 seconds, and a value above 300000 waits 5 minutes. The page still shows the host value and **Locked**.

Saving one of these four and appending the history row is one step. If the history row cannot be written, the settings file is put back and the response is 500 `{ "code": "HISTORY_FAILED" }`. The response does not include the value. Two saves in one process run one after the other, so the later history row's old value is the earlier row's new value. Two processes can each record the old value they read.

A rejected save, including a host-locked name, does not append a history row, because the stored value did not change.

### If a value locks people out

The host environment overrides the settings file. Set the same variable on the host to a value inside the range, then start Cuttlely again. While that host value is set, the API cannot change it. `pnpm settings unset NAME` removes the saved value. For one of these four, a running server picks that up within 5 seconds. A host value still wins until it is removed from the host and Cuttlely is started again.

`CUTTLELY_IGNORE_ADMIN_SETTINGS=1` starts without the settings file. The host value or the default is used.

## History

`GET /api/v1/server-settings/history?cursor=&limit=`

Newest first. Each row is one change: when (`at`), who (`actorId` when a person did it, and `by` for the label the admin page already shows), the key, and the old and new value. A secret key is `{ "key": "NAME", "secret": "changed" }` and the old and new values are not stored. That is true for a first save, a replacement, a removal, a failed save (nothing is stored), and a rollback.

`by` is the label already used on the admin page: an email for a person, `command line`, or `safe boot`. `actorId` is the user id. The response does not add a display name. Only the organization owner can read it.

A save also sets `event` to `server_setting.updated`.

The file is append-only and is not compacted. It can grow for as long as settings keep changing.

| Query    | Meaning                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `limit`  | Page size. Default 50. A number above 100 is treated as 100.                                            |
| `cursor` | Opaque value from `nextCursor`. Asks for rows strictly older than that row. Omit it for the first page. |

```json
{
    "entries": [
        {
            "seq": 3,
            "at": "2026-10-15T00:00:00.000Z",
            "kind": "save",
            "event": "server_setting.updated",
            "by": "owner@example.com",
            "actorId": "user-id",
            "outcome": "ok",
            "changes": [{ "key": "CUTTLELY_LOGIN_FAILURE_LIMIT", "from": "10", "to": "12" }]
        }
    ],
    "nextCursor": null,
    "limit": 50
}
```

`nextCursor` is null on the last page. Send it back as `cursor` to read the next older page. Rows written before `seq` existed still page in file order.

To see that a runtime limit is active, read `GET /api/v1/server-settings` and compare `running` with the value you saved. Within 5 seconds, a queue worker uses that same value.
