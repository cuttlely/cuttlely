# Audit log

**Admin** > **Audit log** (`/audit`) lists sign-in, lockout, invite, reset, role change, user disable, and settings changes, harness runs started with the API (and an API key refused a harness), changes to which harnesses an API key may run, harness schedule changes, including every run a schedule starts and a scheduled run refused because its owner can no longer run the harness, and pinned query changes. The organization owner can open it. A role can open it with `audit:view`. An API key cannot.

The list is newest first. Filter by type, or by a user id, and load the next page from the cursor. One cursor orders database rows and settings changes together, so a page does not skip or repeat a row when both happened at the same time.

![Audit log filtered to Settings changed. The filters are Type and User id, with Apply. The table has When, Type, User, Summary, and Detail. The Detail cell names CUTTLELY_AUDIT_RETENTION_DAYS. The sidebar shows the Admin menu: Users, Teams, Roles, Server Settings, Logs, Audit log, and Version History.](../images/audit/audit-log.png)

Settings changes are the same rows as **Admin** > **Server Settings** > **History**. Only the organization owner sees them here. A role with `audit:view` does not. The Detail column lists each setting name. A secret change is marked hidden and does not show the value.

These values are never stored: passwords, tokens, secret values, question text, client addresses, user agents, and the identifier someone typed when the account is unknown. A sign-in row stores the user id when the account is known, and the method (`local`, `owner`, or `authkit`). A sign-in that matches no account is shown only to the server owner, the earliest active organization owner, and the row has no address and no identifier.

Rows older than the retention are left out. The default is 90 days (`CUTTLELY_AUDIT_RETENTION_DAYS`, from 1 to 3650). Change it under **Admin** > **Server Settings** > **Security & network** > **History** > **Audit log retention**. It applies on the next read. A valid host value wins over the saved value. Settings history keeps its own count (`CUTTLELY_HISTORY_KEEP`) and is not deleted by this retention. A settings change older than the audit retention is left out of this list and still appears on the settings history page while that page's cap keeps it.

A pinned query change is written when a new, changed, or removed pin is stored on Live, including by Publish, or when an editor tests a pin. Until the pinned query editor and test route land, only the Live-save rows are written, without the statement hash; the test row has no caller yet. Saving a draft does not write the create, edit, or delete row. The test row is written when the test runs. The detail names the flow, the node, the pin, the version, the statement hash when the statement compiles, the user, and the kind of change (`create`, `edit`, `delete`, or `test`). It does not include the SQL text or parameter values. A value marked secure is never stored. [Pinned queries](./pinned-queries.md).

The same list is `GET /api/v1/audit`. [Audit API](../reference/audit-api.md).
