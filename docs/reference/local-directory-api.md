# Local users, roles, and sessions

People, roles, and sign-in sessions for [local password sign-in](../how-to/users-without-authkit.md). A team is a workspace. Creating, editing, and listing teams stays on the workspace routes below. This page does not add a second team resource.

These routes answer **404** `{ "message": "Not Found" }` unless local users mode is on: `CUTTLELY_LOCAL_USERS` is exactly `true` and AuthKit is not configured (`WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are not both set). The owner break-glass flag does not turn them on. An API key has no user id, so these routes answer **401**.

The caller's active team is the workspace on the session. Switch with `POST /api/v1/workspace/switch?id=`. A person who is not an owner cannot read or change users, roles assignments, or sessions in another team. That request is **404** `{ "message": "Team not found" }` or `{ "message": "User not found" }`, including when the id exists in the same organization. The organization owner can act on any team in the organization.

## Who may call what

| Action                         | Route                                          | Permission         |
| ------------------------------ | ---------------------------------------------- | ------------------ |
| List people in the active team | `GET /api/v1/users`                            | `users:manage`     |
| Disable or enable              | `PATCH /api/v1/users/:id`                      | `users:manage`     |
| Disable                        | `POST /api/v1/users/:id/disable`               | `users:manage`     |
| Enable                         | `POST /api/v1/users/:id/enable`                | `users:manage`     |
| Assign a role on a team        | `PUT /api/v1/users/:id/role`                   | `workspace:update` |
| List sessions                  | `GET /api/v1/users/:id/sessions`               | `users:manage`     |
| End every session              | `DELETE /api/v1/users/:id/sessions`            | `users:manage`     |
| End one session                | `DELETE /api/v1/users/:id/sessions/:sessionId` | `users:manage`     |
| List roles                     | `GET /api/v1/roles`                            | `roles:manage`     |
| Create a custom role           | `POST /api/v1/roles`                           | `roles:manage`     |
| Edit a custom role             | `PATCH /api/v1/roles/:id`                      | `roles:manage`     |
| Delete a custom role           | `DELETE /api/v1/roles/:id`                     | `roles:manage`     |

The owner of the active team's organization passes every check. An owner role in another organization does not. Anyone else needs the key on their role in the active team. A missing session is **401** `{ "message": "Unauthorized" }`. A signed-in caller without the key is **403** `{ "message": "Forbidden" }`.

An admin cannot grant a permission they do not hold, and cannot assign Owner. That is **403** `{ "message": "You cannot grant a permission you do not have" }` or `{ "message": "Only an owner can assign the owner role" }`. On a team role change, nobody can change their own row, and only an organization owner can change an organization owner's role: **403** `{ "message": "You cannot change your own role" }` or `{ "message": "The organization owner's role cannot be changed" }`. Someone who is not the organization owner also cannot change the role of, or remove from a team, a person whose current team role has a permission they do not hold: **403** `{ "message": "You cannot change the role of someone with permissions you do not have" }` or `{ "message": "You cannot remove someone with permissions you do not have" }`.

## Built-in roles

Seeded once, with stable ids. The permission list is fixed. Create, edit, and delete of these names answer **403** `{ "message": "Built-in roles cannot be changed" }`. Custom roles stay editable.

| Role    | Id                                     | Permissions                                                                                         |
| ------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Owner   | `00000000-0000-4000-8000-000000000001` | Every key in the catalog, plus the owner bypass. Only an owner can assign it.                       |
| Admin   | `00000000-0000-4000-8000-000000000004` | Every catalog key, including people, roles, teams, and server logs.                                 |
| Builder | `00000000-0000-4000-8000-000000000005` | Create, update, delete, and view keys for flows, tools, and data. No people, roles, teams, or logs. |
| Viewer  | `00000000-0000-4000-8000-000000000006` | View keys only. Server logs are not included.                                                       |

`member` and `personal workspace` stay reserved and are not a grant you can edit.

Lowering a role ends every local session for that person and bumps their permission version. A session issued at an older version is rejected, so a cookie from before the change cannot keep the old permissions. Raising a role does not end sessions. The next request reads the new keys. Disabling, deleting, removing the team membership, or shrinking a custom role's keys also ends sessions.

A team role and the organization role are separate. `PUT /api/v1/users/:id/role` and `PUT /api/v1/workspaceuser` change the role on that team and leave the organization role as it is. The exception is Owner: assigning Owner also sets the organization role to owner, and assigning any other role to someone who is currently an owner sets the organization role back to `member`. Invite (`POST /api/v1/account/invite`) stores the chosen role on the team and stores `member` on the organization, unless the chosen role is Owner.

## Last owner

An enabled owner is an active user whose organization membership is active and whose organization role is `owner`. Team rows are not part of that count. A disabled user does not count. An owner with no team still counts.

Disabling or deleting that person, including when they do it to themselves, or another owner demoting them, answers **409** `{ "message": "The last owner cannot be removed" }` when it would leave none. Changing your own team role is **403** `{ "message": "You cannot change your own role" }` before this check runs. Removing the last owner's last non-personal team, or deleting that team, answers the same 409. A second owner can be disabled. The check and the write run in one transaction. On SQLite that transaction starts with `BEGIN IMMEDIATE`. On other databases the owner rows are locked until the transaction commits, so two overlapping removals of the last owner's teams cannot both succeed.

## AuthKit and local password sign-in

`/api/v1/users` and `/api/v1/roles` stay limited to local users mode. Turning AuthKit on deletes every local session at that start, which is the same rows these session routes list, and these routes then answer 404. The older invite, organization user, role, and team routes stay available when AuthKit is on, because those screens are how an AuthKit install adds people. `POST /api/v1/account/invite` stores the person as `invited` and, with AuthKit on, returns or emails a one-time invite link. That person becomes active only through that link: an AuthKit sign-in with a matching email alone shows `You have a pending invite. Open the invite link from your email to join.` Removing a pending person from a team (`DELETE /api/v1/workspaceuser`) or from the organization, or disabling them, marks their open invite links used. Enabling a user never makes a pending invite active. `PUT /api/v1/organizationuser` also accepts `status: "invited"` for a user who is still pending: it keeps them pending and re-opens their organization membership if it was disabled, without making them active. For anyone else it is 400 `{ "message": "Status must be active or inactive" }`. [One-time links](./auth-api.md#one-time-links). The last-owner guard, the permission-version bump, and the active-team checks on those older routes run in both modes. Bumping the version and deleting local session rows is safe when AuthKit is on: an AuthKit session reads permissions from the database on each request, and a local cookie, if one exists, cannot keep the previous permissions. Invite still creates a user with no password.

## List people

`GET /api/v1/users`

Query: `limit` (default 50, max 100), `offset` (default 0), `q` (name or email, at most 100 characters), `sort` (`name`, `email`, `status`, or the same with a leading `-` for descending; default `name`), `status` (`active` or `disable`). `%` and `_` in `q` are matched as those characters. A search of `%` does not match every row.

```json
{
    "users": [
        {
            "id": "6f1c0b5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
            "name": "Ada Lovelace",
            "email": "ada@example.com",
            "disabled": false,
            "status": "active",
            "workspaceId": "8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d",
            "role": { "id": "00000000-0000-4000-8000-000000000005", "name": "builder", "builtIn": true }
        }
    ],
    "limit": 50,
    "offset": 0,
    "total": 1
}
```

## Disable and enable

`PATCH /api/v1/users/:id` with `{ "disabled": true }` or `{ "disabled": false }`.

`POST /api/v1/users/:id/disable` and `POST /api/v1/users/:id/enable` take no body. Repeating one is **200** with the same result. A disabled user cannot sign in. Their local sessions are deleted.

```json
{ "id": "6f1c0b5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", "disabled": true }
```

`disabled` must be a boolean. Anything else is **400** `{ "message": "disabled must be true or false" }`.

## Assign a role

`PUT /api/v1/users/:id/role`

```json
{
    "workspaceId": "8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d",
    "roleId": "00000000-0000-4000-8000-000000000006"
}
```

`workspaceId` must be the caller's active team, unless the caller is the organization owner. An unknown role is **400** `{ "message": "Choose a role" }`. A missing user is **404** `{ "message": "Workspace user not found" }`. Your own row is **403** `{ "message": "You cannot change your own role" }`, and an organization owner's row, unless the caller is an organization owner, is **403** `{ "message": "The organization owner's role cannot be changed" }`. Success is **200** `{ "id": "<user id>" }`.

## Sessions

`GET /api/v1/users/:id/sessions` uses the same `limit` and `offset` as the people list. Sessions are newest first.

```json
{
    "sessions": [
        {
            "id": "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
            "createdAt": "2026-10-14T00:00:00.000Z",
            "idleExpiresAt": "2026-10-14T12:00:00.000Z",
            "absoluteExpiresAt": "2026-10-21T00:00:00.000Z"
        }
    ],
    "limit": 50,
    "offset": 0,
    "total": 1
}
```

The response does not include cookies, bearer tokens, refresh tokens, token hashes, CSRF values, stored chat text, IP addresses, or user agents. Reading a session does not require a second permission beyond `users:manage`.

`DELETE /api/v1/users/:id/sessions` ends every local session for that person and answers **200** `{ "ended": 2 }`. Zero sessions is `{ "ended": 0 }`.

`DELETE /api/v1/users/:id/sessions/:sessionId` ends that one session and answers **200** `{ "id": "<session id>" }`. A missing id, or one that belongs to someone else, is **404** `{ "message": "Session not found" }`. Other sessions stay open.

## Roles

`GET /api/v1/roles` uses `limit`, `offset`, and `q` (matched against the name and the description). `sort` stays `name`.

```json
{
    "roles": [
        {
            "id": "00000000-0000-4000-8000-000000000004",
            "name": "admin",
            "description": "Manages people, roles, and teams. Cannot assign Owner or remove the last owner.",
            "permissions": ["chatflows:view"],
            "builtIn": true,
            "userCount": 1
        }
    ],
    "limit": 50,
    "offset": 0,
    "total": 1
}
```

`permissions` on a built-in role is the fixed set, not a shorter list stored on an older row.

`userCount` is the number of people with that role on the caller's active team. A person who has the role only on another team is not included.

`POST /api/v1/roles` and `PATCH /api/v1/roles/:id` use the same body as `POST /api/v1/role`: `name`, `description`, and `permissions` as a JSON string of catalog keys. The name cannot contain spaces and cannot be a reserved name. The new role belongs to the caller's organization. An `organizationId` in the body is ignored. A role that still has people on any team cannot be deleted (**400** `{ "message": "Remove users with this role first" }`). That check is wider than `userCount`.

On `GET /api/v1/organizationuser`, `roleCount` and `lastLogin` for an organization owner include every team in the organization except Personal Workspace. Anyone else sees only the teams they belong to.

## Teams

These routes are the team API. They are not limited to local users mode, because AuthKit installs use them too. A caller who is not the owner can list, open, edit, and delete only the active team. `GET /api/v1/workspace` for that caller returns that one team. Opening or editing another team is **404** `{ "message": "Team not found" }`. The organization owner can use every team in the organization. `POST /api/v1/account/invite` follows the same active-team rule.

| Action              | Route                           | Permission                                |
| ------------------- | ------------------------------- | ----------------------------------------- |
| List or open a team | `GET /api/v1/workspace`         | `workspace:view`                          |
| Add a team          | `POST /api/v1/workspace`        | `workspace:create`                        |
| Edit a team         | `PUT /api/v1/workspace`         | `workspace:update`                        |
| Delete a team       | `DELETE /api/v1/workspace/:id`  | `workspace:delete`                        |
| Switch team         | `POST /api/v1/workspace/switch` | signed in                                 |
| List members        | `GET /api/v1/workspaceuser`     | `workspace:view`, or `users:manage`       |
| Add a member        | `POST /api/v1/workspaceuser`    | `users:manage` or `workspace:add-user`    |
| Change a member     | `PUT /api/v1/workspaceuser`     | `workspace:update`                        |
| Remove a member     | `DELETE /api/v1/workspaceuser`  | `workspace:unlink-user` or `users:manage` |

`POST /api/v1/workspaceuser` adds someone who already has an account in the organization to a team. Send `workspaceId`, `roleId`, and either `userId` or `email`. It creates no user and keeps their other teams. It follows the same team and role rules as invite: a caller who is not the owner can add only to their active team and cannot grant a role with a key they do not hold. An unknown or outside-the-organization user is 404 `User not found`. Someone already on the team is 409 `This user is already a member of this team`.

`PUT /api/v1/workspaceuser` follows the same assignment rules as `PUT /api/v1/users/:id/role`, including the last-owner guard and session end.

## Errors

| Status | When                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Missing name, team, or role; permissions are not catalog keys; `limit` is outside 1 to 100; `offset` is negative; `disabled` is not a boolean; `sort` or `status` is unknown.                                                                      |
| 401    | No signed-in user.                                                                                                                                                                                                                                 |
| 403    | Missing permission, built-in role edit or delete, grant above the caller, assigning Owner, changing your own team role, changing an organization owner's role as a non-owner, or changing or removing someone whose team role is above the caller. |
| 404    | Local users mode is off; user, role, session, or team is missing; the team is not the caller's active team.                                                                                                                                        |
| 409    | The last owner would be removed. Repeating disable or enable is 200, not 409.                                                                                                                                                                      |

`limit must be from 1 to 100`, `offset must be 0 or greater`, and `Active workspace is required` are the 400 messages for those cases.
