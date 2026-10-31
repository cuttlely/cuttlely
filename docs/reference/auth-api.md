# Auth API

How a browser signs in and how the server reports which methods are on. Owner recovery is always available at `/owner-recovery` and `POST /api/v1/auth/recovery/login`. Teams, roles, and workspace checks are in [Roles and permissions](../how-to/roles-and-permissions.md).

An invite stores a pending (`invited`) user with no password. `link: true` returns a one-time URL the person uses to set a password, or, with AuthKit on, to sign in with WorkOS and join. A pending user is never activated by an AuthKit email match alone. See [One-time links](#one-time-links) and the summary in [Security](../../SECURITY.md#invites).

## Which methods are on

`GET /api/v1/auth/options`

Public. No session and no `x-request-from` header. The body lists only methods that are on:

```json
{
    "methods": ["localUsers"],
    "status": {
        "authKit": false,
        "localPasswordSignIn": true,
        "breakGlassOwner": false,
        "localSessions": "open",
        "sessionsEnded": 0
    }
}
```

| Method       | Present when                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `authKit`    | `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are both set                                                |
| `localAdmin` | `CUTTLELY_LOCAL_ADMIN` is exactly `true`                                                            |
| `localUsers` | `CUTTLELY_LOCAL_USERS` is exactly `true` and AuthKit is not configured                              |
| `mail`       | Omitted. Admin links can email a URL when SMTP is set. The sign-in page has no Forgot password form |

`status` is the AuthKit switch for this server. It is not per team.

| Field                 | Meaning                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authKit`             | `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are both set                                                                                                      |
| `localPasswordSignIn` | `CUTTLELY_LOCAL_USERS` is exactly `true` and AuthKit is not configured                                                                                    |
| `breakGlassOwner`     | `CUTTLELY_LOCAL_ADMIN` is exactly `true`. The owner password route stays on its own flag                                                                  |
| `localSessions`       | `open` when AuthKit is off. `ended` after the switch deleted existing local sessions. `pending` when AuthKit is on and that deletion is not recorded yet  |
| `sessionsEnded`       | How many local sessions were deleted the last time AuthKit became configured. `0` until that happens. Turning AuthKit off does not restore those sessions |

The body has no emails, cookies, or session ids. A missing session is still 200. `POST /api/v1/auth/options` is 404 and does not end sessions.

`GET /api/v1/auth/signin-options` is the same choice as booleans (`authKit`, `localAdmin`, `localUsers`, `mail`, `ownerRecovery`) for the sign-in page. `ownerRecovery` is always true. A false boolean is still returned for the other fields. It does not include `status`. `/auth/options` leaves the off ordinary methods out.

## Flag combinations

`POST /api/v1/auth/local/login` is 404 unless local users mode is on: `CUTTLELY_LOCAL_USERS=true` and AuthKit is not configured. The owner route `POST /api/v1/auth/login` stays on its own flag and still accepts only the owner.

| `CUTTLELY_LOCAL_ADMIN` | `CUTTLELY_LOCAL_USERS` | AuthKit | `POST /api/v1/auth/login` | `POST /api/v1/auth/local/login` | Sign-in page                                                       |
| ---------------------- | ---------------------- | ------- | ------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| off                    | off                    | off     | 404                       | 404                             | Sign-in is not configured. A server with no account opens `/setup` |
| on                     | off                    | off     | Owner password            | 404                             | Owner email and password                                           |
| off                    | on                     | off     | 404                       | Any user with a password        | Email and password                                                 |
| on                     | on                     | off     | Owner password            | Any user with a password        | Email and password (local users)                                   |
| off                    | off                    | on      | 404                       | 404                             | Sign in with WorkOS                                                |
| on                     | off                    | on      | Owner password            | 404                             | Sign in with WorkOS                                                |
| off                    | on                     | on      | 404                       | 404                             | Sign in with WorkOS                                                |
| on                     | on                     | on      | Owner password            | 404                             | Sign in with WorkOS                                                |

AuthKit turns local users mode off even when `CUTTLELY_LOCAL_USERS` is set. The compatibility owner path still follows `CUTTLELY_LOCAL_ADMIN`; owner recovery remains available independently. A restart applies either flag.

Every sign-in-page row also includes the discreet **Owner recovery** link, independent of these flags.

`POST /api/v1/auth/login` is 404 when `CUTTLELY_LOCAL_ADMIN` is not `true`, and 401 `{ "message": "Unauthorized" }` without `x-request-from: internal`. Neither counts as a failure. A wrong email or password is 401. Too many failures for this client address or the owner email, or too many unsuccessful responses from this client across the password routes, is 429 `{ "message": "Too many sign-in attempts. Try again later." }`. The limits are the ones in [Sign in](#sign-in).

## Turning AuthKit on

Set `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` and restart the web server. Activating WorkOS through **Auth / SSO** ends every interactive database session in the switch transaction. A later restart does not repeat that deletion. Owner recovery remains available at `/owner-recovery`.

On the first start after the session-convergence upgrade, Cuttlely records one database cutoff. An older sealed WorkOS browser cookie is cleared and receives 401 from refresh instead of being exchanged into a Cuttlely session. Those users sign in again once. Existing local sessions and API keys are unchanged. Every later WorkOS callback creates an `identity_local_session` row and the `cuttlely-local-session` cookie.

The first verified AuthKit sign-in links an existing user when the mailbox matches exactly. Comparison ignores letter case and spaces around the address. A plus tag, a dot in the name, or a different domain does not match. The stored address is left as it is, and the password hash is left in place so it still works if AuthKit is turned off later. An unverified email is refused and links nobody. Two users with the same mailbox, including in different teams, are refused and neither is linked. A user who is already linked to a different AuthKit id is not rebound.

`GET /api/v1/auth/options` then looks like:

```json
{
    "methods": ["authKit", "localAdmin"],
    "status": {
        "authKit": true,
        "localPasswordSignIn": false,
        "breakGlassOwner": true,
        "localSessions": "ended",
        "sessionsEnded": 2
    }
}
```

`localAdmin` is omitted when the owner flag is off. `sessionsEnded` is how many sessions that start deleted. The how-to is [Users without AuthKit](../how-to/users-without-authkit.md#turn-authkit-on).

A session is stored in `identity_local_session` for local login, WorkOS, and owner recovery. It does not change the user's role. Every later request checks the current user and membership status, permission version, authentication epoch, idle limit, and absolute limit. A disabled user is refused on the next request. Logout deletes the row and clears every session cookie before optional WorkOS sign-out.

`POST /api/v1/auth/recovery/login` requires `x-request-from: internal`, accepts any active owner with a usable local password, and returns the same generic 401 for an unknown address, a non-owner, a disabled owner, or a wrong password. It has a five-attempt source and account lockout. Every outcome is audited. Success creates a persistent administrator alert and recent-authentication evidence.

## Sign in

`POST /api/v1/auth/local/login`

Public, and it requires the header `x-request-from: internal`, the same check as the owner password sign-in. The sign-in page sends that header. Without it, or with any other value, the response is 401 `{ "message": "Invalid email or password." }` and no cookie is set. Another site cannot sign the browser into an account it chose.

Body:

```json
{ "email": "ada@example.com", "password": "Sup3r-Secret!" }
```

The email is trimmed and compared in lower case. An email longer than 254 characters, or a password longer than 256, is 400 and is not looked up or hashed. An empty email or password is 400.

| Status | When                                                                                                                                                 | Body                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 200    | Email and password match an active user who has a password                                                                                           | The session user. The `cuttlely-local-session` cookie is set   |
| 400    | Missing fields, or the email or password is over the length cap                                                                                      | `{ "message": "..." }`                                         |
| 401    | Missing `x-request-from: internal`, unknown email, wrong password, no password stored, or the user is disabled                                       | `{ "message": "Invalid email or password." }`                  |
| 404    | Local users mode is off                                                                                                                              | `{ "message": "Not Found" }`                                   |
| 429    | Too many failures in 15 minutes for this client address or any email, known or not. The default is 10, from `CUTTLELY_LOGIN_FAILURE_LIMIT` (3 to 50) | `{ "message": "Too many sign-in attempts. Try again later." }` |

The 401 body is the same for an unknown email, a wrong password, an invited user with no password, and a disabled user. Each of those runs a password compare. The 429 body is the same no matter which of those states the account is in.

Failures are counted per client address and per email, and both are stored in the database for 15 minutes. An unknown email locks out the same way as a known one. The email is stored as an HMAC of the normalized address, made with the server secret, never as the address itself. Rows older than the window are deleted. If unknown addresses fill the table, the oldest email keys are deleted so the table stays bounded. A new process sees the same lockout. The client address comes from the connection. Proxy headers are trusted only when `TRUST_PROXY` says so.

Four routes also share a separate per-client cap in the current process: `POST /api/v1/auth/local/login`, `POST /api/v1/auth/local/logout`, `POST /api/v1/auth/local/password`, and the owner route `POST /api/v1/auth/login`. Unsuccessful responses on any of the four count toward one limit, and after that many in the same 15 minutes the response is 429 with the same lockout body. The count is `CUTTLELY_LOGIN_FAILURE_LIMIT` (10 unless you change it) and a saved change applies without a restart. A successful sign-in, sign-out, or password change does not count toward that process cap. A request without `x-request-from: internal`, or while that route's mode is off (local users mode for the three local routes, `CUTTLELY_LOCAL_ADMIN` for the owner route), is rejected before that cap and does not count. A restart drops that process cap. Both database lockouts survive a restart: the client-address rows and the email rows.

A success sets a new cookie. The value is not the stored token: the database keeps a SHA-256 of it. Idle time is 12 hours (`CUTTLELY_SESSION_IDLE_MINUTES`, 15 to 1440) and the session ends 7 days after it was created (`CUTTLELY_SESSION_ABSOLUTE_HOURS`, 1 to 720) even if it is still in use. Idle time cannot be longer than the absolute lifetime. A shorter value applies to a session that is already signed in: every later request checks the current limits, and the cookie expiry alone does not keep the session. The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` under the same rule as the break-glass cookie. `Secure` follows the redirect URI's scheme, and the request when that URI is unset. A trusted proxy's scheme counts when `TRUST_PROXY` says so. Sign-out clears the cookie with that same flag. The organization owner changes these limits, and the failure limit, from Server settings. They apply without a restart. [Server settings API](./server-settings-api.md).

A disabled user (user status other than `active`, or an organization membership of `disable`) cannot sign in. Their session rows are deleted, so an old cookie fails on the next request. That check is in the database, so it holds after a restart and on another instance.

## Sign out

`POST /api/v1/auth/local/logout`

Requires the header `x-request-from: internal`. A missing or any other value is 401 `{ "message": "Unauthorized" }`.

With that header the route returns 200 `{ "message": "logged_out", "redirectTo": "/signin" }` and clears the cookie. Calling it again returns that same body. The session row for the cookie is deleted, so the old cookie no longer signs anyone in.

The route is 404 when local users mode is off. `POST /api/v1/account/logout` is the in-app sign-out. When the `cuttlely-local-session` cookie is present, that route also requires `x-request-from: internal` and deletes that session row, including when only local users mode is on. The same delete runs on the AuthKit sign-out and when the request has no other session.

## Change your own password

`POST /api/v1/auth/local/password`

Requires the caller's own local session and `x-request-from: internal`. There is no field that selects another user. A `userId` in the body is ignored.

```json
{ "currentPassword": "An0ther-Secret!", "newPassword": "Sup3r-Secret!" }
```

| Status | When                                                                                       | Body                                                           |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 200    | The current password matches. The body is the session user. This browser gets a new cookie | The session user                                               |
| 400    | A password is missing, too long, fails the strength rules, or the new password is the same | `{ "message": "..." }`                                         |
| 401    | No session, or the CSRF header is missing or not `internal`                                | `{ "message": "Unauthorized" }`                                |
| 401    | The current password is wrong                                                              | `{ "message": "Invalid email or password." }`                  |
| 404    | Local users mode is off                                                                    | `{ "message": "Not Found" }`                                   |
| 429    | This client or account is locked out from earlier failures                                 | `{ "message": "Too many sign-in attempts. Try again later." }` |

The route is public, like sign-out, so a missing session still reaches this handler and returns 401 `{ "message": "Unauthorized" }`. A call with no session cookie returns that same body. A wrong current password uses `{ "message": "Invalid email or password." }`. The new password must be at least 8 characters and include a lower-case letter, an upper-case letter, a digit, and a symbol, and it must not be the current password.

The current session is replaced. Every other session for that user is deleted. An old cookie from this browser or another one fails on the next request.

## One-time links

These routes set a password, or accept an invite through AuthKit, without an admin typing one. The URL is a secret. It is returned once. Examples below use the fake token `exampletokenexampletokenexampletoken12`. That value is not a real token. Do not log the URL, put it in a query string, or send it to a channel you do not control.

The token is 32 random bytes, encoded so it can sit in a fragment. The database stores SHA-256 of it, plus the purpose (`invite` or `reset`), organization, team, user, expiry, and the time it was used. A newer token for the same user, purpose, and team marks the older one used. The raw value is not stored and cannot be fetched again.

`POST /api/v1/account/invite`

Requires `users:manage` or `workspace:add-user`. Returning or emailing a link requires `users:manage` or the organization owner, or `workspace:add-user` when the invite is into the caller's own active team. A `workspace:add-user` caller asking for a link for another team gets 403 `{ "message": "Forbidden" }`, and an invite into another team without a link is 404 `{ "message": "Team not found" }`. With AuthKit on an invite always carries a link, so this is the rule for every AuthKit invite. The body is the same user, team, and role object the invite already accepts, plus optional `link`.

| `link`  | Mail configured | Status | Body                                                                                                                              |
| ------- | --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| omitted | either          | 200    | `{ "id" }` only, when invite delivery is follow the request (the default) and AuthKit is off. No token and no email.              |
| `true`  | no              | 200    | `{ "id", "link" }`. `link` is `https://host/local-accept#token=...`                                                               |
| `true`  | yes             | 200    | `{ "id", "link", "mailed" }`. `mailed` is true when the email went out                                                            |
| `false` | yes             | 200    | `{ "id", "mailed": true }`. The URL is only in the email                                                                          |
| `false` | no              | 400    | `{ "message": "Mail is not configured. Set link to true to receive a one-time link, or configure mail first." }` Nothing is saved |
| other   | either          | 400    | `{ "message": "link must be true or false" }`                                                                                     |

A caller cannot grant a role that contains a permission they do not hold, unless they are the organization owner. The owner role cannot be granted. A password field on the user is ignored.

Invite delivery (`INVITE_DELIVERY`, in Server settings or the environment) applies only when `link` is omitted. `link` returns the URL, as `link: true` does. `email` sends it, as `link: false` does, and fails the same way when mail is not configured. `request`, and an unset value, keep the `{ "id" }` response while AuthKit is off. With AuthKit on they behave like `link`, because the invite link is the only way a pending user can join. A request that sets `link` still wins. A saved Server settings value overrides the environment. Reset links do not use this setting.

`POST /api/v1/users/:id/reset-link`

Requires `users:manage`. `:id` must be a user in the caller's current team. Another team's id is 404 `{ "message": "User not found" }`, the same as an unknown id.

| Target                                                                                     | Status | Body                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| Organization owner                                                                         | 403    | `{ "message": "The organization owner cannot be reset from a link." }`                                        |
| AuthKit-linked user (`externalId`, SSO provider, or SSO subject)                           | 403    | `{ "message": "This account signs in with an outside identity and has no local password." }`                  |
| Service account (status `service`, SSO provider `service`, or role name `service account`) | 403    | `{ "message": "A service account cannot be reset from a link." }`                                             |
| Disabled user                                                                              | 403    | `{ "message": "This account is disabled." }`                                                                  |
| Role with a permission the caller lacks                                                    | 403    | `{ "message": "You cannot reset this account." }`                                                             |
| Eligible user                                                                              | 200    | `{ "link" }` when `link` is omitted or true. `{ "mailed": true }` when `link` is false and mail is configured |
| Pending (`invited`) user                                                                   | 200    | The same bodies. The link is a new invite link, and the older invite link stops working                       |

`link: false` without mail is the same 400 as the invite, and no token is stored. The organization owner may reset an eligible user even when that user's role lists permissions the owner role row does not. Issuing the link does not end sessions.

`POST /api/v1/auth/local/accept`

Public. No session. Send `{ "token", "password" }` in the JSON body. A `token` query parameter is ignored. The route is rate limited: 10 failures from one client address in 15 minutes, then 429 `{ "message": "Too many attempts. Try again later." }`.

| Status | When                                                                                                                                                        | Body                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | The token matches an unused, unexpired invite or reset for an eligible local user, and the password meets the strength rules                                | `{ "message": "Password saved." }`                                                                                                                                            |
| 400    | The token is missing, unknown, expired, already used, for another team, or the user is not eligible (without AuthKit, an owner invite is not eligible here) | `{ "message": "This link is not valid." }`                                                                                                                                    |
| 400    | A token is present and the password fails a strength rule                                                                                                   | `{ "message": "<the rule>" }` The token stays unused                                                                                                                          |
| 400    | AuthKit is configured and the token is a live invite, including an owner invite (a used, expired, or revoked one gets `This link is not valid.`)            | `{ "message": "This invite is accepted by signing in with WorkOS, not with a password. Open your invite link and select Accept invite with WorkOS." }` The token stays unused |
| 429    | Too many failures from this client address                                                                                                                  | `{ "message": "Too many attempts. Try again later." }`                                                                                                                        |

An empty or missing token always returns `{ "message": "This link is not valid." }`, including when the password is also weak. When a token is present and the password fails a strength rule, the response is that rule. The token is not read and is not consumed, so a valid token stays unused and the response does not show that the token is live.

Two accepts of the same token cannot both succeed. The used mark and the password write are one transaction. A reset, and only a reset, deletes every `identity_local_session` row for that user in that same transaction. An old cookie then fails. An invite does not delete sessions.

Invite links last 72 hours (`INVITE_TOKEN_EXPIRY_IN_HOURS`, 1 to 168). Reset links last 60 minutes (`PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS`, 5 to 1440). A value saved in Server settings overrides the environment. Blank, zero, negative, and non-integers are ignored. A number below the minimum is raised to the minimum, and a number above the maximum is lowered to the maximum. Mail uses `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE`, `SMTP_USER`, and `SENDER_EMAIL` the same way. `SMTP_PASSWORD` stays in the environment and is not returned by Server settings. See [Server settings API](server-settings-api.md#invite-and-reset).

`POST /api/v1/auth/invite/start`

Public. No session. Answers 404 unless AuthKit is configured, and 401 `{ "message": "Unauthorized" }` without `x-request-from: internal`. Send `{ "token" }` in the JSON body. A missing token, or one longer than 256 characters, is 400 `{ "message": "This invite link is not valid. Ask for a new invite." }`. Otherwise the answer is 200 `{ "url": "/api/v1/auth/login" }` with an httpOnly, `SameSite=Lax` cookie `cuttlely-invite`, scoped to `Path=/api/v1/auth/callback`, that holds the token for 15 minutes. Starting does not use the token and does not say whether it is valid. `/local-accept` calls this route and then opens the URL.

The AuthKit callback reads that cookie, expires it on that same path on every outcome, and decides:

| Signed-in user                                        | Result                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Active user                                           | Signed in as before. The cookie is ignored                                                                               |
| Pending user, no cookie                               | Back to `/signin` with `You have a pending invite. Open the invite link from your email to join.` The user stays pending |
| Pending user, cookie with a valid token for that user | One transaction marks the token used, sets the user `active`, and stores the AuthKit user id on the user. Signed in      |
| Pending user, any other token                         | Back to `/signin` with `This invite link is not valid. Ask for a new invite.` The user and the token stay as they were   |

A valid token is an unused, unexpired invite token made for that user, whose stored email matches the verified AuthKit email (letter case and surrounding spaces ignored), while that user is still pending, in the same organization and team, and not disabled there. Removing the user from the team or the organization, or disabling them, marks their open invite tokens used, so adding them back does not revive a token. An AuthKit email that matches no user still gets `No account exists for this email.`, and the token is not used.

Audit rows in `identity_action_audit` record link issued, token consumed, token rejected (expired, reused, superseded, ineligible, another user's token, or another email), password set, and sessions revoked. They store ids and a short reason. They do not store the token, the URL, or the email.

## Errors

Failures from these routes use `{ "message": "..." }`. The sign-in, sign-out, change-password, and accept routes are on the public list, so a call with no session reaches the route and gets the bodies above, for example 401 `{ "message": "Unauthorized" }` from `POST /api/v1/auth/local/password`.

The routes that need a session, such as `POST /api/v1/account/invite` and `POST /api/v1/users/:id/reset-link`, are refused before the route when the call has no session and no valid API key. That response comes from the API gate and uses a different key:

```json
{ "error": "Unauthorized Access" }
```

The status is 401, with or without `x-request-from: internal`. A signed-in browser that sends a write without `x-request-from: internal` gets 401 `{ "message": "Unauthorized" }` from that same gate.

The server does not log the password, the hash, the cookie, a setup code, the raw email, or a one-time token. A token in a query string or a fragment is redacted before a request line is written.
