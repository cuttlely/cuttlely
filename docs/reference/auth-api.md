# Auth API

How a browser signs in when AuthKit is off, and how the server reports which methods are on. The owner break-glass route is unchanged. Teams, roles, and workspace checks are in [Roles and permissions](../how-to/roles-and-permissions.md).

An invite with no `link` field still stores the user with no password. `link: true` returns a one-time URL the person uses to set a password. See [One-time links](#one-time-links).

## Which methods are on

`GET /api/v1/auth/options`

Public. No session and no `x-request-from` header. The body lists only methods that are on:

```json
{ "methods": ["localUsers"] }
```

| Method       | Present when                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `authKit`    | `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are both set                                                |
| `localAdmin` | `CUTTLELY_LOCAL_ADMIN` is exactly `true`                                                            |
| `localUsers` | `CUTTLELY_LOCAL_USERS` is exactly `true` and AuthKit is not configured                              |
| `mail`       | Omitted. Admin links can email a URL when SMTP is set. The sign-in page has no Forgot password form |

`GET /api/v1/auth/signin-options` is the same choice as booleans (`authKit`, `localAdmin`, `localUsers`, `mail`) for the sign-in page. A false boolean is still returned there. `/auth/options` leaves the off methods out.

## Flag combinations

`POST /api/v1/auth/local/login` is 404 unless local users mode is on: `CUTTLELY_LOCAL_USERS=true` and AuthKit is not configured. The owner route `POST /api/v1/auth/login` stays on its own flag and still accepts only the owner.

| `CUTTLELY_LOCAL_ADMIN` | `CUTTLELY_LOCAL_USERS` | AuthKit | `POST /api/v1/auth/login` | `POST /api/v1/auth/local/login` | Sign-in page                         |
| ---------------------- | ---------------------- | ------- | ------------------------- | ------------------------------- | ------------------------------------ |
| off                    | off                    | off     | 404                       | 404                             | Sign-in is not configured            |
| on                     | off                    | off     | Owner password            | 404                             | Owner email and password             |
| off                    | on                     | off     | 404                       | Any user with a password        | Email and password                   |
| on                     | on                     | off     | Owner password            | Any user with a password        | Email and password (local users)     |
| off                    | off                    | on      | 404                       | 404                             | Sign in with WorkOS                  |
| on                     | off                    | on      | Owner password            | 404                             | WorkOS, plus the owner password form |
| off                    | on                     | on      | 404                       | 404                             | Sign in with WorkOS                  |
| on                     | on                     | on      | Owner password            | 404                             | WorkOS, plus the owner password form |

AuthKit turns local users mode off even when `CUTTLELY_LOCAL_USERS` is set. The owner break-glass path still works when `CUTTLELY_LOCAL_ADMIN=true`. A restart applies either flag.

A local session is the user id in `identity_local_session`. It does not make that user the owner. Every later request checks that user's role. The owner break-glass cookie is the same cookie name, and when local users mode is off only the owner's row is accepted.

## Sign in

`POST /api/v1/auth/local/login`

Public, and it requires the header `x-request-from: internal`, the same check as the owner password sign-in. The sign-in page sends that header. Without it, or with any other value, the response is 401 `{ "message": "Invalid email or password." }` and no cookie is set. Another site cannot sign the browser into an account it chose.

Body:

```json
{ "email": "ada@example.com", "password": "Sup3r-Secret!" }
```

The email is trimmed and compared in lower case. An email longer than 254 characters, or a password longer than 256, is 400 and is not looked up or hashed. An empty email or password is 400.

| Status | When                                                                                                           | Body                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 200    | Email and password match an active user who has a password                                                     | The session user. The `cuttlely-local-session` cookie is set   |
| 400    | Missing fields, or the email or password is over the length cap                                                | `{ "message": "..." }`                                         |
| 401    | Missing `x-request-from: internal`, unknown email, wrong password, no password stored, or the user is disabled | `{ "message": "Invalid email or password." }`                  |
| 404    | Local users mode is off                                                                                        | `{ "message": "Not Found" }`                                   |
| 429    | Ten failures in 15 minutes for this client address or any email, known or not                                  | `{ "message": "Too many sign-in attempts. Try again later." }` |

The 401 body is the same for an unknown email, a wrong password, an invited user with no password, and a disabled user. Each of those runs a password compare. The 429 body is the same no matter which of those states the account is in.

Failures are counted per client address and per email, and both are stored in the database for 15 minutes. An unknown email locks out the same way as a known one. The email is stored as an HMAC of the normalized address, made with the server secret, never as the address itself. Rows older than the window are deleted. If unknown addresses fill the table, the oldest email keys are deleted so the table stays bounded. A new process sees the same lockout. The client address comes from the connection. Proxy headers are trusted only when `TRUST_PROXY` says so.

These three routes also share a separate per-client cap in the current process: 10 responses that are not successful, in the same 15 minutes, and then 429 with the same lockout body. A successful sign-in, sign-out, or password change does not count toward that process cap. A request without `x-request-from: internal`, and a request while local users mode is off, is rejected before that cap and does not count. A restart drops that process cap. Both database lockouts survive a restart: the client-address rows and the email rows.

A success sets a new cookie. The value is not the stored token: the database keeps a SHA-256 of it. Idle time is 12 hours. The session ends 7 days after it was created even if it is still in use. The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` under the same rule as the break-glass cookie. `Secure` follows the redirect URI's scheme, and the request when that URI is unset. A trusted proxy's scheme counts when `TRUST_PROXY` says so. Sign-out clears the cookie with that same flag.

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

The route is public, like sign-out, so a missing session still reaches this handler and returns 401 `{ "message": "Unauthorized" }`. A wrong current password uses `{ "message": "Invalid email or password." }`. The new password must be at least 8 characters and include a lower-case letter, an upper-case letter, a digit, and a symbol, and it must not be the current password.

The current session is replaced. Every other session for that user is deleted. An old cookie from this browser or another one fails on the next request.

## One-time links

These routes set a password without an admin typing one. The URL is a secret. It is returned once. Examples below use the fake token `exampletokenexampletokenexampletoken12`. That value is not a real token. Do not log the URL, put it in a query string, or send it to a channel you do not control.

The token is 32 random bytes, encoded so it can sit in a fragment. The database stores SHA-256 of it, plus the purpose (`invite` or `reset`), organization, team, user, expiry, and the time it was used. A newer token for the same user, purpose, and team marks the older one used. The raw value is not stored and cannot be fetched again.

`POST /api/v1/account/invite`

Requires `users:manage` or `workspace:add-user` for the previous behavior. Returning or emailing a link requires `users:manage` (the organization owner can too). The body is the same user, team, and role object the invite already accepts, plus optional `link`.

| `link`  | Mail configured | Status | Body                                                                                                                              |
| ------- | --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| omitted | either          | 200    | `{ "id" }` only, when invite delivery is follow the request (the default). No token and no email.                                 |
| `true`  | no              | 200    | `{ "id", "link" }`. `link` is `https://host/local-accept#token=...`                                                               |
| `true`  | yes             | 200    | `{ "id", "link", "mailed" }`. `mailed` is true when the email went out                                                            |
| `false` | yes             | 200    | `{ "id", "mailed": true }`. The URL is only in the email                                                                          |
| `false` | no              | 400    | `{ "message": "Mail is not configured. Set link to true to receive a one-time link, or configure mail first." }` Nothing is saved |
| other   | either          | 400    | `{ "message": "link must be true or false" }`                                                                                     |

A caller cannot grant a role that contains a permission they do not hold, unless they are the organization owner. The owner role cannot be granted. A password field on the user is ignored.

Invite delivery (`INVITE_DELIVERY`, in Server settings or the environment) applies only when `link` is omitted. `link` returns the URL, as `link: true` does. `email` sends it, as `link: false` does, and fails the same way when mail is not configured. `request`, and an unset value, keep the `{ "id" }` response. A request that sets `link` still wins. A saved Server settings value overrides the environment. Reset links do not use this setting.

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

`link: false` without mail is the same 400 as the invite, and no token is stored. The organization owner may reset an eligible user even when that user's role lists permissions the owner role row does not. Issuing the link does not end sessions.

`POST /api/v1/auth/local/accept`

Public. No session. Send `{ "token", "password" }` in the JSON body. A `token` query parameter is ignored. The route is rate limited: 10 failures from one client address in 15 minutes, then 429 `{ "message": "Too many attempts. Try again later." }`.

| Status | When                                                                                                                         | Body                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 200    | The token matches an unused, unexpired invite or reset for an eligible local user, and the password meets the strength rules | `{ "message": "Password saved." }`                                   |
| 400    | The token is missing, unknown, expired, already used, for another team, or the user is not eligible                          | `{ "message": "This link is not valid." }`                           |
| 400    | The password fails a strength rule                                                                                           | `{ "message": "<the rule>" }` The token is not read and stays unused |
| 429    | Too many failures from this client address                                                                                   | `{ "message": "Too many attempts. Try again later." }`               |

A missing or unknown token sent with a password that fails those rules gets the same rule. The response does not show that a token is live.

Two accepts of the same token cannot both succeed. The used mark and the password write are one transaction. A reset, and only a reset, deletes every `identity_local_session` row for that user in that same transaction. An old cookie then fails. An invite does not delete sessions.

Invite links last 72 hours (`INVITE_TOKEN_EXPIRY_IN_HOURS`, 1 to 168). Reset links last 60 minutes (`PASSWORD_RESET_TOKEN_EXPIRY_IN_MINS`, 5 to 1440). A value saved in Server settings overrides the environment. Blank, zero, negative, and non-integers are ignored. A number below the minimum is raised to the minimum, and a number above the maximum is lowered to the maximum. Mail uses `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE`, `SMTP_USER`, and `SENDER_EMAIL` the same way. `SMTP_PASSWORD` stays in the environment and is not returned by Server settings. See [Server settings API](server-settings-api.md#invite-and-reset).

Audit rows in `identity_action_audit` record link issued, token consumed, token rejected (expired, reused, superseded, or ineligible), password set, and sessions revoked. They store ids and a short reason. They do not store the token, the URL, or the email.

## Errors

Failures use `{ "message": "..." }`. The server does not log the password, the hash, the cookie, a setup code, the raw email, or a one-time token. A token in a query string or a fragment is redacted before a request line is written.
