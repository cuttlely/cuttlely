# Audit API

One list of sign-in, lockout, invite, reset, role change, user disable, authentication and settings changes, harness runs started with the API, changes to an API credential's harness list, harness schedule changes, and pinned query changes. How to open it in the app: [Audit log](../how-to/audit-log.md).

`POST /api/v1/audit/login-activity` stays **404** `{ "message": "Not Found" }`.

## Who may call it

`GET /api/v1/audit`

The organization owner of the active team, or a role with `audit:view` on that team. A missing session is **401** `{ "error": "Unauthorized Access" }`. A signed-in caller without the key is **403** `{ "message": "Forbidden" }`. An API key has no user id, so it is **403** even when the key list contains `audit:view`. Creating or updating an API key with `audit:view` is **400**.

A caller who is not the owner sees events for the active team, and sign-in rows for people in that team. Events for another team, and events for another organization, are left out. The owner sees events for every team in the organization.

Settings changes are the settings history rows. They are included only for the organization owner. A role with `audit:view` does not receive `setting_change` rows. They have no user id, so a `user` filter leaves them out.

A sign-in or lockout that matches no account is stored without an address, a user agent, or the identifier that was attempted. That row is returned only to the server owner (the earliest active organization owner). An organization owner of another organization does not receive it.

The response sends `Cache-Control: no-store`.

## Query

| Query    | Meaning                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor` | Opaque. One key for the merged list: time, then source, then id. Asks for rows strictly older than the last row of the previous page. A bad cursor is **400**. |
| `type`   | One of the types below. Omit it for every type. Anything else is **400** `{ "code": "INVALID_TYPE" }`.                                                         |
| `user`   | User id. At most 255 characters. A longer value is **400** `{ "code": "INVALID_USER" }`.                                                                       |
| `limit`  | Page size. Default 50. Maximum 100. `0` or a non-number is **400** `{ "code": "INVALID_LIMIT" }`.                                                              |

Types: `sign_in_success`, `sign_in_failure`, `lockout`, `invite`, `reset`, `role_change`, `user_disable`, `setting_change`, `harness_run`, `harness_access`, `harness_schedule`, `pinned_query_change`, `auth_method_change`, `auth_config_warning_ack`, `auth_config_change`, `owner_recovery`.

`user_disable` includes an enable. `detail.disabled` is true or false.

`harness_run` is a run started through `POST /api/v1/harnesses/:name/runs/async`, or a harness run an API key was refused because the harness is not on its list. `detail` has `harness`, `outcome` (`started` or `refused`), `via` (`api_key` or `session`), the key's id as `keyId` for an API key, and `runId` for a start. The question is not stored. `harness_access` is a change to the harnesses an API key may run: `detail` has `keyId`, `keyName`, `harnesses`, and `previous`. `harness_schedule` is a schedule saved, paused, resumed, or deleted (`detail.action` is `saved`, `paused`, `resumed`, or `deleted`, with `cron`, `timezone`, and `status`), a scheduled run started (`detail.action` is `run_started`, with the `runId`), or a scheduled run refused because the owner can no longer run the harness (`detail.action` is `run_refused`). For a scheduled run, `userId` is the owner. All three name the team.

`pinned_query_change` is written best-effort when a new, changed, or removed pin is stored on Live, including by Publish, or after a successful test of a pin; an audit failure does not block the save. A draft save does not write a `create`, `edit`, or `delete` row. The test row is best-effort: it is attempted only after a successful test, a refused or failed test writes none, and an audit failure does not block the test result. `detail.kind` is `create`, `edit`, `delete`, or `test`. `detail` also has `flow`, `node`, `pin` (the tool name), `version`, `hash` (the statement hash, when the pin compiles), `user`, and may have `cred` (the credential id) and `paramNames`. It does not include SQL text or parameter values. [Pinned queries](../how-to/pinned-queries.md).

`auth_config_change` is recorded when an administrator saves a generic OIDC draft, including a draft whose provider check reports an error, and when tested settings are copied to the active OIDC configuration without changing the selected method. `detail.outcome` is `saved`, `saved_with_error`, or `applied_to_active`; `detail.configurationFingerprint` is the saved or applied configuration fingerprint, or null when one was not produced.

A bad cursor is **400** `{ "message": "Cursor is not valid", "code": "INVALID_CURSOR" }`.

## Response

```json
{
    "events": [
        {
            "id": "6f1c0b5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
            "type": "sign_in_failure",
            "at": "2026-10-15T12:00:00.000Z",
            "userId": "8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d",
            "actorId": "8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d",
            "workspaceId": null,
            "summary": "Sign-in failed",
            "detail": { "method": "local" }
        }
    ],
    "nextCursor": null,
    "limit": 50
}
```

`nextCursor` is null on the last page. `workspaceId` is null for a sign-in and for a user disable. A role change and an invite name the team.

`detail` never includes a password, a token, a secret value, or question text. A settings change names each key. A secret key is `{ "key": "SMTP_PASSWORD", "values": "hidden" }`. A plain key includes `from` and `to`.

## Retention

`CUTTLELY_AUDIT_RETENTION_DAYS` is a runtime setting. Default 90. Range 1 to 3650. A valid host value, then the saved value, then 90. It applies on the next read. Rows older than that are removed. Settings history uses `CUTTLELY_HISTORY_KEEP` and is not removed by this setting. [Server settings API](./server-settings-api.md).
