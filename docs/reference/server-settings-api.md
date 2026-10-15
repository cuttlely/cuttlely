# Server settings API

Owner-only settings for this server. The page is **Admin** > **Server settings**. This page is the HTTP API. A runtime limit applies on the next use. Every other saved value applies at the next start.

`GET /api/v1/server-settings`

`PUT /api/v1/server-settings`

The caller must be the organization owner, with a signed-in session. A missing session and an API key are 401. A signed-in caller who is not the owner is 403. Secrets are accepted on `PUT` and are never returned.

## Read

`GET` returns every setting the page knows. Each setting includes its key, label, help, type, and where the value comes from.

| Field       | Meaning                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | `host` when the environment sets it, `file` when Server settings saved it, `default` when neither did. A runtime limit uses `panel` for a value saved in Server settings. `bounded` when a host value on the other side of a pair forced this number. |
| `boundedBy` | The host key that forced a `bounded` value, for example `CUTTLELY_CHECK_COUNT_MAX`. Absent otherwise. The field stays editable.                                                                                                                       |
| `runtime`   | `true` when the limit is read on each use. Absent on settings that wait for a restart.                                                                                                                                                                |
| `range`     | `{ "min", "max" }` for a runtime limit. Whole numbers, inclusive.                                                                                                                                                                                     |
| `unit`      | `tokens`, `seconds`, `minutes`, `ms`, or `count` for these limits.                                                                                                                                                                                    |
| `value`     | The saved or host value. Empty when the default applies. Omitted for secrets.                                                                                                                                                                         |
| `effective` | The value in use, including the default. Omitted for secrets.                                                                                                                                                                                         |
| `locked`    | `true` when the host set the variable, so `PUT` cannot change it.                                                                                                                                                                                     |

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

`code` is `OUT_OF_RANGE` for a number outside the range, `INVALID` for a value that is not a whole number, and `CROSS_FIELD` for a pair. `min` and `max` are the bounds that apply to that save. `errors` lists the same problem by key. A host value that is not a usable number is ignored on read: the saved value is used when it is in range, and otherwise the default. The read does not fail. An in-range host value on a pair always wins and is not loosened. The other setting falls back through its saved value and then its default. If none fit, that setting is bounded by the host value. Its `source` is `bounded`, and `boundedBy` names the host key. It is not `host`. `locked` stays false unless that same variable is also set on the host, so the field can still be edited. A host `CUTTLELY_CHECK_COUNT_MAX` of 1 makes the effective question default 1, bounded by `CUTTLELY_CHECK_COUNT_MAX`. A host `CUTTLELY_RATING_SCAN_CAP` of 300 makes the effective import cap 300, bounded by `CUTTLELY_RATING_SCAN_CAP`. When both sides are host values and they conflict, the cap is kept and the other side is bounded by it. The warning names the key only. A settings file that is not valid JSON is ignored the same way, and `GET` still returns 200. `range.max` for `CUTTLELY_CHECK_COUNT_DEFAULT` is the question cap in effect, not the static 500.

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
| `CUTTLELY_HARNESS_TURN_SCAN_CAP` | 2000    | 500 to 20000                               | count   |
| `CUTTLELY_RATING_IMPORT_CAP`     | 500     | 50 to 5000                                 | count   |
| `CUTTLELY_RATING_SCAN_CAP`       | 1000    | at least the import cap, and at most 20000 | count   |
| `CUTTLELY_UI_PAGE_LIMIT_MAX`     | 3000    | 100 to 50000                               | count   |

The question cap default of 100 and the concurrency default of 2 are the same numbers the publish check used before these settings existed. With nothing set, behaviour is unchanged. How to set them in the page: [Limits that apply immediately](../how-to/server-settings.md#limits-that-apply-immediately).
