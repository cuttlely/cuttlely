# Auth API

How a browser signs in when AuthKit is off, and how the server reports which methods are on. The owner break-glass route is unchanged. Teams, roles, and workspace checks are in [Roles and permissions](../how-to/roles-and-permissions.md).

Until password links exist, only a user who already has a password can sign in here. That is the owner created with the setup code, and the break-glass owner. An invited user is stored with no password. No route in this API sets another user's password.

## Which methods are on

`GET /api/v1/auth/options`

Public. No session and no `x-request-from` header. The body lists only methods that are on:

```json
{ "methods": ["localUsers"] }
```

| Method       | Present when                                                                |
| ------------ | --------------------------------------------------------------------------- |
| `authKit`    | `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are both set                        |
| `localAdmin` | `CUTTLELY_LOCAL_ADMIN` is exactly `true`                                    |
| `localUsers` | `CUTTLELY_LOCAL_USERS` is exactly `true` and AuthKit is not configured      |
| `mail`       | Reserved. Password reset by email is not available, so this name is omitted |

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
| 429    | Ten failures in 15 minutes for this client or this known account                                               | `{ "message": "Too many sign-in attempts. Try again later." }` |

The 401 body is the same for an unknown email, a wrong password, an invited user with no password, and a disabled user. Each of those runs a password compare. The 429 body is the same no matter which of those states the account is in.

Failures are counted per client address and per email, and both are stored in the database for 15 minutes. An unknown email locks out the same way as a known one. The email is stored as an HMAC of the normalized address, made with the server secret, never as the address itself. Rows older than the window are deleted. If unknown addresses fill the table, the oldest email keys are deleted so the table stays bounded. A new process sees the same lockout. The client address comes from the connection. Proxy headers are trusted only when `TRUST_PROXY` says so.

These three routes also share a separate per-client cap in the current process: 10 responses that are not successful, in the same 15 minutes, and then 429 with the same lockout body. A successful sign-in, sign-out, or password change does not count toward that process cap. The lockout that survives a restart is the database one above.

A success sets a new cookie. The value is not the stored token: the database keeps a SHA-256 of it. Idle time is 12 hours. The session ends 7 days after it was created even if it is still in use. The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when the request is https or the process is in production.

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

## Errors

Failures use `{ "message": "..." }`. The server does not log the password, the hash, the cookie, a setup code, or the raw email.
