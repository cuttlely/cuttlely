# Audit log

**Admin** > **Audit log** (`/audit`) lists sign-in, lockout, invite, reset, role change, user disable, and settings changes. The organization owner can open it. A role can open it with `audit:view`. An API key cannot.

The list is newest first. Filter by type, or by a user id, and load the next page from the cursor. One cursor orders database rows and settings changes together, so a page does not skip or repeat a row when both happened at the same time.

Settings changes are the same rows as **Admin** > **Server Settings** > **History**. Only the organization owner sees them here. A role with `audit:view` does not. A secret change shows the setting name and that the value changed. It does not show the value.

These values are never stored: passwords, tokens, secret values, question text, client addresses, user agents, and the identifier someone typed when the account is unknown. A sign-in row stores the user id when the account is known, and the method (`local`, `owner`, or `authkit`). A sign-in that matches no account is shown only to the server owner, the earliest active organization owner, and the row has no address and no identifier.

Rows older than the retention are left out. The default is 90 days (`CUTTLELY_AUDIT_RETENTION_DAYS`, from 1 to 3650). Change it under **Admin** > **Server Settings** > **Security & network** > **History** > **Audit log retention**. It applies on the next read. A valid host value wins over the saved value. Settings history keeps its own count (`CUTTLELY_HISTORY_KEEP`) and is not deleted by this retention. A settings change older than the audit retention is left out of this list and still appears on the settings history page while that page's cap keeps it.

The same list is `GET /api/v1/audit`. [Audit API](../reference/audit-api.md).
