# Server settings API

Owner-only settings for this server. The page is **Admin** > **Server settings**. This page is the HTTP API. A runtime limit applies on the next use. Every other saved value applies at the next start.

`GET /api/v1/server-settings`

`PUT /api/v1/server-settings`

The caller must be the organization owner, with a signed-in session. A missing session and an API key are 401. A signed-in caller who is not the owner is 403. Secrets are accepted on `PUT` and are never returned.

These settings are instance-wide. One install has one settings file. A workspace role cannot read or change them, including a workspace admin whose session lists permissions from another workspace. The organization owner is an organization role, so that person can call this API from any workspace they are signed into.

`GET` and `PUT` above are for ordinary settings. Env-only values are a separate list, [Read-only host values](#read-only-host-values). An ordinary setting still includes `value` (or `secret` for a secret). A read-only row does not.

## Read

`GET` returns every setting the page knows. Each setting includes its key, label, help, type, and where the value comes from.

| Field       | Meaning                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | `host` when the environment sets it, `file` when Server settings saved it, `default` when neither did. A runtime limit uses `panel` for a value saved in Server settings. `bounded` when a host value on the other side of a pair forced this number. |
| `boundedBy` | The host key that forced a `bounded` value, for example `CUTTLELY_CHECK_COUNT_MAX`. Absent otherwise. The field stays editable unless that same variable is also set on the host, in which case it is locked.                                         |
| `runtime`   | `true` when the limit is read on each use. Absent on settings that wait for a restart.                                                                                                                                                                |
| `range`     | `{ "min", "max" }` for a runtime limit. Whole numbers, inclusive.                                                                                                                                                                                     |
| `unit`      | `tokens`, `seconds`, `minutes`, `ms`, or `count` for these limits.                                                                                                                                                                                    |
| `value`     | The saved or host value. Empty when the default applies. Omitted for secrets.                                                                                                                                                                         |
| `effective` | The value in use, including the default. Omitted for secrets.                                                                                                                                                                                         |
| `locked`    | `true` when the host set the variable, so `PUT` cannot change it. Invite and mail settings stay editable: a saved value overrides the host. `SMTP_PASSWORD` is always locked.                                                                         |

`source`, `boundedBy`, `runtime`, `range`, and `unit` are response fields. A `PUT` body does not send them.

## Write

```json
{ "values": { "CUTTLELY_CHECK_MAX_TOKENS": "5000" } }
```

Send only the settings that change. A number may be a string or a JSON number. An empty string removes the saved value. A body that is not `{ "values": { ... } }` returns 400.

A runtime limit must be a whole number inside its range. A float, an exponent, `NaN`, `Infinity`, or a number past the safe integer range is rejected. A value outside the range is rejected. Nothing is clamped.

Two pairs are checked against the values in effect after the save, including a change to only one side:

| Rule                   | Holds when                                                           |
| ---------------------- | -------------------------------------------------------------------- |
| Question count default | `CUTTLELY_CHECK_COUNT_DEFAULT` is at most `CUTTLELY_CHECK_COUNT_MAX` |
| Rating scan            | `CUTTLELY_RATING_SCAN_CAP` is at least `CUTTLELY_RATING_IMPORT_CAP`  |

A refusal is 400:

```json
{
    "code": "OUT_OF_RANGE",
    "key": "CUTTLELY_CHECK_MAX_SECONDS",
    "reason": "Publish check time limit: the value must be from 10 to 1800.",
    "min": 10,
    "max": 1800
}
```

`code` is `OUT_OF_RANGE` for a number outside the range, `INVALID` for a value that is not a whole number, and `CROSS_FIELD` for a pair. `min` and `max` are the bounds that apply to that save. `errors` lists the same problem by key. A host value that is not a usable number is ignored on read: the saved value is used when it is in range, and otherwise the default. The read does not fail. An in-range host value on a pair always wins and is not loosened. The other setting falls back through its saved value and then its default. If none fit, that setting is bounded by the host value. Its `source` is `bounded`, and `boundedBy` names the host key. It is not `host`. `locked` stays false unless that same variable is also set on the host, so the field can still be edited. A host `CUTTLELY_CHECK_COUNT_MAX` of 1 makes the effective question default 1, bounded by `CUTTLELY_CHECK_COUNT_MAX`. A host `CUTTLELY_RATING_SCAN_CAP` of 300 makes the effective import cap 300, bounded by `CUTTLELY_RATING_SCAN_CAP`. When both sides are host values and they conflict, the host cap is kept and the other side uses the first saved or default candidate that fits. `bounded` applies only when no candidate fits. The warning names the key only. A settings file that is not valid JSON is ignored the same way, and `GET` still returns 200. `range.max` for `CUTTLELY_CHECK_COUNT_DEFAULT` is the question cap in effect, not the static 500. `range.max` for `CUTTLELY_RATING_IMPORT_CAP` is the rating scan cap in effect. `range.min` for `CUTTLELY_RATING_SCAN_CAP` is the import cap in effect.

## Runtime limits

| Variable                         | Default | Range                                      | Unit    |
| -------------------------------- | ------- | ------------------------------------------ | ------- |
| `CUTTLELY_CHECK_MAX_TOKENS`      | 100000  | 1000 to 2000000                            | tokens  |
| `CUTTLELY_CHECK_MAX_SECONDS`     | 180     | 10 to 1800                                 | seconds |
| `CUTTLELY_CHECK_CONCURRENCY`     | 2       | 1 to 8                                     | count   |
| `CUTTLELY_CHECK_RUN_TIMEOUT_MS`  | 60000   | 10000 to 600000                            | ms      |
| `CUTTLELY_CHECK_KEEP_MINUTES`    | 30      | 5 to 1440                                  | minutes |
| `CUTTLELY_CHECK_COUNT_MAX`       | 100     | 1 to 500                                   | count   |
| `CUTTLELY_CHECK_COUNT_DEFAULT`   | 4       | 1 to the question cap                      | count   |
| `CUTTLELY_CHECK_SCAN_CAP`        | 2000    | 500 to 20000                               | count   |
| `CUTTLELY_HARNESS_TURN_SCAN_CAP` | 2000    | 500 to 5000                                | count   |
| `CUTTLELY_RATING_IMPORT_CAP`     | 500     | 50 to 5000                                 | count   |
| `CUTTLELY_RATING_SCAN_CAP`       | 1000    | at least the import cap, and at most 20000 | count   |
| `CUTTLELY_UI_PAGE_LIMIT_MAX`     | 3000    | 100 to 50000                               | count   |

The question cap default of 100 and the concurrency default of 2 are the same numbers the publish check used before these settings existed. With nothing set, behaviour is unchanged. How to set them in the page: [Limits that apply immediately](../how-to/server-settings.md#limits-that-apply-immediately).

## Security limits

These are runtime limits too. The same read order applies: a valid host value, then the saved value, then the default. `CUTTLELY_HISTORY_KEEP` is the exception: a value saved on the page wins over the environment variable. A host value outside the range is ignored. A save outside the range is refused. Idle time cannot be longer than the absolute lifetime (`CUTTLELY_SESSION_IDLE_MINUTES` must be at most `CUTTLELY_SESSION_ABSOLUTE_HOURS` times 60). That refusal is `CROSS_FIELD`.

| Variable                          | Default | Range                                                | Unit    |
| --------------------------------- | ------- | ---------------------------------------------------- | ------- |
| `CUTTLELY_LOGIN_FAILURE_LIMIT`    | 10      | 3 to 50                                              | count   |
| `CUTTLELY_SESSION_IDLE_MINUTES`   | 720     | 15 to 1440, and no longer than the absolute lifetime | minutes |
| `CUTTLELY_SESSION_ABSOLUTE_HOURS` | 168     | 1 to 720, and long enough to cover the idle time     | count   |
| `CUTTLELY_DRAIN_TIMEOUT_MS`       | 25000   | 5000 to 300000                                       | ms      |
| `CUTTLELY_HISTORY_KEEP`           | 1000    | 100 to 10000                                         | count   |

A shorter idle or absolute lifetime applies to a session that is already signed in. Every authenticated request checks the current limits: a local session cookie, and an AuthKit session. The cookie expiry alone does not keep the session. An AuthKit session is remembered by its WorkOS session id, which stays the same when the access token is refreshed. The first request this server sees for that id starts the clock. Later requests record activity at most once a minute, so idle means unused. An API key is not one of these sessions.

The process that saved the value invalidates its cache at once. The HTTP server and a queue worker re-read the settings file at least every 5 seconds. The shutdown wait is read when a shutdown starts.

If one of these locks people out, set the same variable on the host to a value inside the range and start Cuttlely again. The host value overrides the saved one, and the API cannot change it while the host value is set. `pnpm settings unset NAME` removes the saved value. `CUTTLELY_IGNORE_ADMIN_SETTINGS=1` starts without the settings file.

## History

`GET /api/v1/server-settings/history?cursor=&limit=`

Organization owner only. The same 401 and 403 rules as the other settings routes apply. A workspace admin, a member, and a user in another workspace are 403.

Newest first. Each row has when (`at`), who (`actorId` is the user id when a person did it, and `by` is the label the admin page already shows), the key, and the old and new value. A secret is `{ "key": "NAME", "secret": "changed" }`. The old and new values are not stored on a first save, a replacement, a removal, a failed save (nothing is written), or a rollback.

`by` stays the existing label: an email for a person, `command line`, or `safe boot`. The response does not add a display name. A save sets `event` to `server_setting.updated`.

`CUTTLELY_HISTORY_KEEP` is how many of these rows to keep. It is a setting on Admin > Server settings, under Security & network, in the History group (Settings changes to keep). It is not an environment-only row. The default is 1000. A saved value must be a whole number from 100 to 10000, and a save outside that range is refused. A value saved on the page wins over `CUTTLELY_HISTORY_KEEP` in the environment. With nothing saved, a valid environment value is used, then 1000. A host value outside 100 to 10000 is ignored. The field stays editable when the environment sets it. `effective` is the number in effect. `source` is `panel` when the page saved it, `host` when only the environment sets it, or `default`. The page says panel, env, or default for those three. On each new row the file is rewritten to the newest rows only, under a lock, as one temporary file moved into place. A row that is still inside that cap is not dropped when two saves append at the same time. A cursor that pointed at a row now past the cap reads the older rows that are still kept, or an empty page when none remain.

| Query    | Meaning                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`  | Page size. Default 50. A number above 100 is treated as 100. `0` or a value that is not a whole number is 400 `INVALID`.              |
| `cursor` | Opaque value from `nextCursor`. Rows strictly older than that row. Omit it for the first page. Anything else is 400 `INVALID_CURSOR`. |

A rejected save, including a host-locked name, does not append a history row. Saving and appending the history row is one step. If the history row cannot be written, the settings file is put back and the response is 500 `{ "code": "HISTORY_FAILED" }`. The body does not include the value. Two saves in one process run one after the other, so the later row's old value is the earlier row's new value.

`nextCursor` is null on the last page.

## Invite and reset

These settings are read on each use. A saved value overrides the environment. `source` is `panel` when Server settings saved it, `host` when the environment supplies the value in use, and `default` otherwise. `effective` is the value in use. `range` is present for the two lifetimes and the mail port. `locked` is false, so `PUT` can change them while the environment also sets them. A restart is not required.

A lifetime or port must be a whole number inside its range. A value outside the range is rejected. Nothing saved here is clamped. An environment value below the minimum is raised to the minimum, and one above the maximum is lowered to the maximum. A blank, zero, negative, or non-integer environment value is ignored. The read does not fail. The warning names the key only.

| Variable                              | Default   | Range or values               |
| ------------------------------------- | --------- | ----------------------------- |
| `INVITE_TOKEN_EXPIRY_IN_HOURS`        | 72        | 1 to 168 hours                |
| `PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS` | 60        | 5 to 1440 minutes             |
| `INVITE_DELIVERY`                     | `request` | `request`, `link`, or `email` |
| `SMTP_HOST`                           | empty     | one line                      |
| `SMTP_PORT`                           | 587       | 1 to 65535                    |
| `SMTP_SECURE`                         | `false`   | `true` or `false`             |
| `SMTP_USER`                           | empty     | one line                      |
| `SENDER_EMAIL`                        | empty     | one email address             |

`INVITE_DELIVERY` is `request` (follow the request), `link` (copy link), or `email`. It applies when an invite omits `link`. An invite that sets `link` still wins. With nothing saved and nothing in the environment, an omitted `link` still returns `{ "id" }` only.

`SMTP_PASSWORD` is env-only. `GET` returns `secret.set` and omits `value` and `effective`. `PUT` is rejected. A password stored in the settings file is ignored. `pnpm settings list` prints `(set, hidden)` or `(not set)`. `SMTP_STARTTLS` is not a panel setting. It stays in the environment.

The same key is also a read-only status row. That row is `env` when the environment holds a password and `unset` when it does not. It does not include the password. See [Read-only host values](#read-only-host-values).

How to set them in the page: [Invite and reset](../how-to/server-settings.md#invite-and-reset).

## Read-only host values

Some values must stay in the environment. The API reports whether each one is set. It does not report the value, the length, a hash, a file path, a host name, or a connection string. A client should use `readOnly` and must not assume every setting has `value`.

`GET /api/v1/server-settings/read-only`

```json
{
    "scope": "instance",
    "settings": [{ "key": "PORT", "set": true, "source": "env", "readOnly": true }]
}
```

`GET /api/v1/server-settings/read-only/:key` returns that one object. An unknown name, including a name that is an ordinary setting, is 404 `{ "code": "NOT_FOUND", "message": "No read-only setting with that name." }`. The message does not repeat the name from the path.

The same rows are on `GET /api/v1/server-settings` as `readOnly`. They are not mixed into `settings`.

`source` on a read-only row is one of `env`, `file`, `default`, or `unset`. That enum is only for this list. Ordinary settings still use `host`, `file`, `default`, `panel`, and `bounded`.

| `source`  | Meaning                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `env`     | The environment holds a value this key accepts. `set` is true.                                                        |
| `file`    | A sign-in secret was read from its file under a configured `SECRETKEY_PATH`. `set` is true. The path is not returned. |
| `default` | The variable is blank, and the server has a built-in. `set` is false. The built-in is not returned.                   |
| `unset`   | Nothing usable is configured. `set` is false.                                                                         |

A blank value, a value that is only spaces, or a value the key does not accept is not `set: true`. Examples: `PORT=0` or `PORT=70000`, `REDIS_URL` that is not a `redis:` or `rediss:` URL, `REDIS_TLS=TRUE`, a `SECRETKEY_PATH` that is not an existing directory, a secret file that is empty or only spaces, and `SECRETKEY_STORAGE_TYPE` other than `aws`. `aws` is the only storage type that counts as set. A blank value leaves the local key file (`source: default`). Any other text is `source: unset`.

Sign-in secrets (`JWT_AUTH_TOKEN_SECRET`, `JWT_REFRESH_TOKEN_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `EXPRESS_SESSION_SECRET`, `TOKEN_HASH_SECRET`) use `source: file` only when `SECRETKEY_PATH` is an existing directory and that secret's file has a non-empty value. The status call does not create the directory or the file. When `SECRETKEY_PATH` is unset, those keys are `unset` even if a file exists somewhere else.

The list is fixed. The server does not scan the process environment for names that start with a prefix.

`SMTP_PASSWORD` is the mail password. The invite settings field shows whether it is set and never the value. This list reports the same fact as `source` `env` or `unset`. A copy in the settings file does not count. Saving it is refused with `READ_ONLY`.

| Key                                        | Counts as set when                                               |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `PORT`                                     | An integer from 1 to 65535                                       |
| `HOST`                                     | Non-blank text                                                   |
| `CUTTLELY_DATA_DIR`                        | Non-blank text. Blank uses the built-in data directory           |
| `MODE`                                     | `queue` or `main`. Blank uses the built-in mode                  |
| `LOG_PATH`                                 | Non-blank text. Blank uses the built-in log directory            |
| `BLOB_STORAGE_PATH`                        | Non-blank text. Blank uses the built-in storage path             |
| `SECRETKEY_PATH`                           | An existing directory                                            |
| `SECRETKEY_STORAGE_TYPE`                   | `aws`                                                            |
| `SECRETKEY_AWS_ACCESS_KEY`                 | Non-blank text                                                   |
| `SECRETKEY_AWS_SECRET_KEY`                 | Non-blank text                                                   |
| `SECRETKEY_AWS_REGION`                     | Non-blank text                                                   |
| `SECRETKEY_AWS_NAME`                       | Non-blank text                                                   |
| `FLOWISE_SECRETKEY_OVERWRITE`              | Non-blank text                                                   |
| `CUTTLELY_SECRETKEY_OVERWRITE`             | Non-blank text                                                   |
| `JWT_AUTH_TOKEN_SECRET`                    | Environment text, or a non-empty secret file                     |
| `JWT_REFRESH_TOKEN_SECRET`                 | Environment text, or a non-empty secret file                     |
| `JWT_ISSUER`                               | Environment text, or a non-empty secret file                     |
| `JWT_AUDIENCE`                             | Environment text, or a non-empty secret file                     |
| `EXPRESS_SESSION_SECRET`                   | Environment text, or a non-empty secret file                     |
| `TOKEN_HASH_SECRET`                        | Environment text, or a non-empty secret file                     |
| `REDIS_URL`                                | A `redis:` or `rediss:` URL with a host                          |
| `REDIS_HOST`                               | Non-blank text. Blank uses the built-in host                     |
| `REDIS_PORT`                               | An integer from 1 to 65535. Blank uses the built-in port         |
| `REDIS_USERNAME`                           | Non-blank text                                                   |
| `REDIS_PASSWORD`                           | Non-blank text                                                   |
| `REDIS_TLS`                                | `true` or `false`. Blank uses the built-in                       |
| `REDIS_CERT`                               | Base64 that decodes to bytes                                     |
| `REDIS_KEY`                                | Base64 that decodes to bytes                                     |
| `REDIS_CA`                                 | Base64 that decodes to bytes                                     |
| `CUSTOM_MCP_PROTOCOL`                      | Non-blank text                                                   |
| `CUSTOM_MCP_ALLOWED_COMMANDS`              | Non-blank text                                                   |
| `CUSTOM_MCP_ALLOWED_ENV_VARS`              | Non-blank text                                                   |
| `CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS` | Non-blank text                                                   |
| `CUSTOM_MCP_SECURITY_CHECK`                | `true` or `false`                                                |
| `TOOL_FUNCTION_BUILTIN_DEP`                | Non-blank text                                                   |
| `TOOL_FUNCTION_EXTERNAL_DEP`               | Non-blank text                                                   |
| `ALLOW_BUILTIN_DEP`                        | `true` or `false`                                                |
| `HTTP_SECURITY_CHECK`                      | `true` or `false`                                                |
| `PATH_TRAVERSAL_SAFETY`                    | `true` or `false`                                                |
| `OAUTH2_SECURITY_CHECK`                    | `true` or `false`                                                |
| `CUTTLELY_ETL_ROOTS`                       | Non-blank text                                                   |
| `PUPPETEER_EXECUTABLE_PATH`                | Non-blank text                                                   |
| `PUPPETEER_EXECUTABLE_FILE_PATH`           | Non-blank text                                                   |
| `PLAYWRIGHT_EXECUTABLE_PATH`               | Non-blank text                                                   |
| `PLAYWRIGHT_EXECUTABLE_FILE_PATH`          | Non-blank text                                                   |
| `SANDBOX_TIMEOUT`                          | Non-blank text                                                   |
| `LANGSMITH_API_KEY`                        | Non-blank text                                                   |
| `LANGSMITH_TRACING`                        | `true` or `false`                                                |
| `LANGSMITH_TRACING_V2`                     | `true` or `false`                                                |
| `SMTP_PASSWORD`                            | Non-blank text. Also shown on the invite field as set or not set |

`LANGSMITH_PROJECT` and `LANGSMITH_ENDPOINT` are ordinary settings, not rows in this list. `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_ENDPOINT`, and `LANGCHAIN_TRACING_V2` stay ordinary settings too. The LangSmith API key is `LANGSMITH_API_KEY` above, and the response never includes it.

`GET /api/v1/settings`, the setup link, and a public chat config do not include `readOnly` or any of these values.

### Writes

A read-only key cannot be saved, changed, or removed.

| Method and path                                                    | Result                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/v1/server-settings` with a read-only key                 | 400. Nothing is written. If every key in `values` is read-only, `code` is `READ_ONLY`. A mix with any other error is `INVALID`, and each read-only row has `code: "READ_ONLY"`. |
| `PUT`, `PATCH`, or `DELETE /api/v1/server-settings/read-only/:key` | 400 `{ "code": "READ_ONLY", "message": "This setting cannot be changed." }` when the key is in the list. 404 when it is not.                                                    |
| `PATCH` or `DELETE /api/v1/server-settings/read-only`              | 400 `READ_ONLY`                                                                                                                                                                 |
| `PATCH` or `DELETE /api/v1/server-settings`                        | 400 `READ_ONLY` when `values` names a read-only key. 405 `METHOD_NOT_ALLOWED` when it does not. Ordinary changes stay on `PUT`.                                                 |

The error body does not include the submitted text. A rejected write is not added to History.

```json
{
    "code": "READ_ONLY",
    "message": "This setting cannot be changed.",
    "errors": [{ "key": "PORT", "code": "READ_ONLY", "message": "This setting cannot be changed." }]
}
```

### Ordinary settings for logs and LangSmith

`LOG_SANITIZE_BODY_FIELDS` and `LOG_SANITIZE_HEADER_FIELDS` are lists of field names. Each name starts with a letter and then uses letters, numbers, hyphens, or underscores, up to 64 characters, and at most 40 names. Names are stored in lower case. A bad list is 400 with `code: "INVALID_NAME"` on that error. The message does not repeat the submitted text.

`LANGSMITH_PROJECT` is a name of up to 128 characters: letters, numbers, spaces, dots, hyphens, or underscores. A bad name is 400 `INVALID_NAME`.

`LANGSMITH_ENDPOINT` is an `http` or `https` address with a host, no user name, no password, no query, and no fragment, up to 200 characters. A bad address is 400 `INVALID_URL`. The message does not repeat the address.

An empty string clears any of these, the same as other ordinary settings. A restart applies them.

Knowing that a secret exists is enough to operate the server. Returning the secret, how long it is, a hash of it, the path it was read from, or the Redis address would tell a stolen owner session more than it needs.
