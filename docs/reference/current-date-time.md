# Current date and time

The **CurrentDateTime** tool (`current_date_time`) returns the weekday, the calendar date, the clock time, the timezone name, the UTC offset, an ISO-8601 instant and a unix timestamp.

The `current_date_time` value in a prompt is separate. It stays the UTC instant from `toISOString`.

## Timezone

With no timezone set, the JSON string is the same as before. `date` and `iso8601` come from `toISOString`, so the date is the UTC date. The clock, weekday, timezone name and offset follow the server's own timezone.

Set a default IANA timezone in either place:

-   **Timezone** on the CurrentDateTime node.
-   `CUTTLELY_DEFAULT_TIMEZONE`, read when the tool runs. The node value wins when it is not blank.

A call can pass `timezone`, an IANA name such as `America/Chicago`. That value wins over the node and the environment variable. Blank text is the same as leaving it out.

`2026-10-24T01:30:00Z` in `America/Chicago` is Friday `2026-10-23`, `20:30:00`, offset `-05:00`.

`iso8601` and `unix_timestamp` stay the absolute instant. `date`, `time`, `day`, `timezone` and `timezoneOffset` follow the chosen timezone. Names Node accepts are used, including links such as `US/Central` (reported as `America/Chicago`). The `timezone` field is that canonical name.

An unknown timezone does not crash the call. The result is the same JSON plus `error`, and the tool uses the next valid timezone: the node, then `CUTTLELY_DEFAULT_TIMEZONE`, then the output from when no timezone is set.

Existing nodes show **Timezone** after **Sync Nodes**. The node version is 1.1.

## Daylight saving time

`America/Chicago` in 2026 moves the clocks forward on 8 March and back on 1 November.

| Instant (UTC)        | Local time | Offset |
| -------------------- | ---------- | ------ |
| 2026-03-08T07:30:00Z | 01:30:00   | -06:00 |
| 2026-03-08T08:00:00Z | 03:00:00   | -05:00 |
| 2026-11-01T06:30:00Z | 01:30:00   | -05:00 |
| 2026-11-01T07:30:00Z | 01:30:00   | -06:00 |

The spring change skips the hour from 02:00 through 02:59. The autumn change repeats 01:00 through 01:59. The offset tells those two hours apart.
