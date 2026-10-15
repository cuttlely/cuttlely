<!--
Copyright 2026 The Cuttlely Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# identity

Apache-2.0 home for Cuttlely sign-in, teams, roles, and the session snapshot.

Phase 1 is the AuthKit and break-glass runtime. `index.ts` exports the spec version and the routers.

Sign-in is WorkOS AuthKit (`@workos-inc/node`) when `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are both set. AuthKit is optional. Without those two, set `CUTTLELY_LOCAL_ADMIN=true` and create one Super User on an empty database (`pnpm user --email`, or loopback `POST /api/v1/account/register`). That is the single-admin shape: one built-in admin and a password form on `/signin`. A missing WorkOS configuration does not turn the flag on. `GET /api/v1/auth/login` redirects to AuthKit only when WorkOS is configured. The callback stores a sealed `wos-session` cookie. `WORKOS_REDIRECT_URI` is sent unchanged. Logout `returnTo` is that URL's origin plus `/signin`.

The first verified user becomes Super User only when the database is empty and the email matches `CUTTLELY_BOOTSTRAP_EMAIL` (case-insensitive). If that variable is unset, bootstrap is refused.

One local break-glass Super User exists when `CUTTLELY_LOCAL_ADMIN=true`. Break-glass password hashes are scrypt only. `pnpm user --email ...` reads it from a masked prompt (no echo) or from stdin, not from an argument. Ten failed sign-ins for one account, or from one IP, lock that account or that IP for 15 minutes. A later success does not clear the window. That lockout is expected. Session tokens are stored as sha256. `POST /api/v1/account/register` under the flag is accepted only from loopback. That check uses the socket peer when `TRUST_PROXY` is unset, so a reverse proxy on the same host looks like loopback and the real client is not seen. Set `TRUST_PROXY` if a local proxy sits in front. When the flag is off, that route answers 404. An empty user table with a leftover `identity_bootstrap` row is treated as not bootstrapped: the row is deleted in the same transaction and the first owner can be created again.

When WorkOS and the local-admin flag are unset, sign-in routes answer 404. There is no commercial router to call. Teams, roles, and API keys stay in Cuttlely's database.

Phase 2 adds `requirePermission` and `requireAnyPermission`. `requirePermission` takes one permission per argument and throws if that argument contains a comma. `requireAnyPermission` takes a comma-separated any-of list. A signed-in user is allowed when the user and the organization membership are `active` and the team status is `active` or `invited`. The stored closed team value is `disable`. Sign-in marks a chosen `invited` team and that user's `invited` organization membership `active`, and does not change `disable`. Super User is the organization owner role in the database. The gate does not rewrite `req.user.permissions`. An API key is allowed only by its own permissions. Apache routes use this gate.

Phase 5 points Teams, Users, and Roles at this module. `POST /api/v1/account/invite` with no `link` field creates an `active` user with a null credential. That person can AuthKit-login immediately. `link: true` also returns a one-time URL whose fragment carries the token. `POST /api/v1/users/:id/reset-link` returns a one-time reset URL for a local user in the current team. `POST /api/v1/auth/local/accept` sets the password from that token. Server settings can set the invite lifetime, the reset lifetime, invite delivery, and the mail server, port, TLS flag, user, and sender address. A saved value overrides the environment. The mail password stays in the environment. A reset deletes that user's local sessions after the password is saved. A row that is already `invited` is linked and stored as `active` on AuthKit login. `GET /api/v1/auth/signin-options` returns `{ authKit, localAdmin, localUsers, mail }` with no secrets. `GET /api/v1/auth/options` returns `{ methods }` listing only the methods that are on. The sign-in page shows "Sign in with WorkOS" when `authKit` is true, the local-users email and password form when `localUsers` is true, and the owner password form when `localAdmin` is true and local users mode is off. `localUsers` is true only when `CUTTLELY_LOCAL_USERS` is exactly `true` and AuthKit is not configured. `POST /api/v1/auth/local/login`, `POST /api/v1/auth/local/logout`, and `POST /api/v1/auth/local/password` are that mode. No route sets another user's password. `GET /api/v1/auth/permissions/ROLE` and `GET /api/v1/auth/permissions/API_KEY` return catalogs whose rows include `isOpenSource`, `isEnterprise`, and `isCloud`.

Phase 6 stops SSO provider modules and Stripe quota fetches on the Apache boot path. Quota helpers return without reading a subscription. `POST /api/v1/account/register` is 404 when `CUTTLELY_LOCAL_ADMIN` is off, including from loopback. Forgot-password, reset-password, resend-verification, confirm-email-change, verify, and billing are 404. Datasets, evaluations, and evaluators stay mounted and answer 403. `GET /api/v1/pricing` answers 404.

Phase 7 deletes the commercial tree. `initAuthSecrets` in this module loads JWT and session values from the environment, then from a file under `SECRETKEY_PATH`. AuthKit does not read those values. Boot uses `ossIdentity()` with no cast to a commercial manager. Apache routes use `requirePermission` and `requireAnyPermission`. Export, import, audit, organization, login methods, and logs answer 404. The BullMQ dashboard is not mounted; `/admin/queues` answers 404 when queue mode and the dashboard flag are both set. Cuttlely does not run queue mode.
