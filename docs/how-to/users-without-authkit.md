# Users without AuthKit

Use this when several people sign in with email and password on a server you run, and you are not using WorkOS AuthKit. It is off until you turn it on. The first owner is still created with the setup code. There is no default password.

Until a sign-in link exists, only someone who already has a password can sign in. That is the owner from the setup code, and the break-glass owner. Inviting someone in the app creates an active user with no password. No API sets that password for them. A link that does is not in this version.

The owner password form (`CUTTLELY_LOCAL_ADMIN`) is a separate switch. [Sign in](./sign-in.md) covers that one account. This page is the switch for every other user who already has a password.

## Turn it on

Set `CUTTLELY_LOCAL_USERS` to exactly `true` and restart. In **Admin** > **Server Settings** > **Sign-in & identity**, the switch is **Local user passwords**. It is off unless you set it.

Leave AuthKit unset. If `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are both set, this mode stays off. The owner break-glass form can still be on. The combinations are in the [Auth API](../reference/auth-api.md#flag-combinations).

## Sign in

Open `/signin`. When this mode is on, the page shows **Email** and **Password** and posts to `POST /api/v1/auth/local/login`.

A wrong email, an unknown email, an invited user with no password, and a disabled user all show `Invalid email or password.` Ten failures in 15 minutes, from one browser address or against one email, show `Too many sign-in attempts. Try again later.` An unknown email locks the same way.

The session is that user. It does not make them the organization owner. A role change applies on the next request. Disabling the user, signing out, or changing the password ends the session, including after a restart.

## Change your password

While signed in, `POST /api/v1/auth/local/password` with the current password and a new one. The request needs the header `x-request-from: internal`, which the Cuttlely app sends. The new password has to meet the usual strength rules and must differ from the current one. Other browsers are signed out. This browser stays signed in with a new cookie.

Sign out with `POST /api/v1/auth/local/logout` and the same header. Calling it twice is fine.

`GET /api/v1/auth/options` lists the methods that are actually on, for example `{ "methods": ["localUsers"] }`.

The field names, status codes, and cookie flags are in the [Auth API](../reference/auth-api.md).
