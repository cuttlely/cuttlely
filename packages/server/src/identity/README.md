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

Sign-in is WorkOS AuthKit (`@workos-inc/node`) when `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are both set. AuthKit is optional. Without those two, set `CUTTLELY_LOCAL_ADMIN=true` and create one Super User on an empty database (`pnpm user --email`, or `POST /api/v1/account/register` with the one-time code from the server log). A missing WorkOS configuration does not turn the flag on. `GET /api/v1/auth/login` redirects to AuthKit only when WorkOS is configured. Every successful WorkOS callback creates an `identity_local_session` row and the `cuttlely-local-session` cookie; sealed WorkOS values are not application session credentials. `WORKOS_REDIRECT_URI` is sent unchanged.

The first verified user becomes Super User only when the database is empty and the email matches `CUTTLELY_BOOTSTRAP_EMAIL` (case-insensitive). If that variable is unset, bootstrap is refused.

`/owner-recovery` and `POST /api/v1/auth/recovery/login` are always available for any active owner with a usable local password. `CUTTLELY_LOCAL_ADMIN=true` keeps the older owner route available for compatibility but is not part of recovery readiness. Recovery uses a five-attempt source and account limit, records mandatory outcome-specific audits, creates a persistent administrator alert on success, and records recent authentication. `pnpm user --email ...` reads the password from a masked prompt or stdin, not from an argument. Session tokens are stored as sha256. `POST /api/v1/account/register` under the compatibility flag needs `x-request-from: internal` and the one-time code from the setup link in the server log.

When WorkOS and ordinary local login are unset, the owner recovery page remains available. Teams, roles, and API keys stay in Cuttlely's database.

Phase B2 converges interactive session ownership. `sessionConvergence.ts` writes the one-time database cutoff for older sealed WorkOS browser sessions. `handlers.ts` issues and validates the shared database session for local, WorkOS, and recovery sign-in, checks the user status on every request, and performs local logout before optional remote logout. `authenticationSecrets.ts` derives the epoch-binding and reauthentication-state secrets from `TOKEN_HASH_SECRET` with distinct HKDF labels. `recovery.ts` owns mandatory recovery audit, persistent alerts, acknowledgment audit, structured warnings, and owner email notification. `authenticationRoutes.ts` exposes the Auth / SSO state, switch limits, and alert acknowledgment. `schemaMigration.ts` and migration `1801100000000` add the convergence marker, recovery alerts, session metadata, and API-key owner metadata.

Phase C-a adds SCIM v2 User provisioning at `/api/v1/scim/v2`. `scim.ts` owns the dedicated bearer lifecycle, discovery documents, filters, User operations, SCIM errors, and provisioning audit. `directory.ts` supplies the shared atomic account-deactivation transaction used by SCIM and the administrator path. `authenticationRoutes.ts` exposes credential create, rotate, overlap end, revoke, and status to **Auth / SSO**. `authenticationSecrets.ts` derives the SCIM HMAC material under its own `TOKEN_HASH_SECRET` label. Migration `1801200000000` adds SCIM configuration, credential, user-link, and personal-token state, plus persisted API-key disable time. Groups and role mappings are not part of this pass.

Phase 2 adds `requirePermission` and `requireAnyPermission`. `requirePermission` takes one permission per argument and throws if that argument contains a comma. `requireAnyPermission` takes a comma-separated any-of list. A signed-in user is allowed when the user and the organization membership are `active` and the team status is `active` or `invited`. The stored closed team value is `disable`. Sign-in marks a chosen `invited` team and that user's `invited` organization membership `active`, and does not change `disable`. Super User is the organization owner role in the database. The gate does not rewrite `req.user.permissions`. An API key is allowed only by its own permissions. Apache routes use this gate.

Phase 5 points Teams, Users, and Roles at this module. `POST /api/v1/account/invite` creates an `invited` (pending) user with a null credential. With AuthKit on, it always returns or emails a one-time invite link. `link: true` also returns a one-time URL whose fragment carries the token. `POST /api/v1/users/:id/reset-link` returns a one-time reset URL for a local user in the current team. `POST /api/v1/auth/local/accept` sets the password from that token. Server settings can set the invite lifetime, the reset lifetime, invite delivery, and the mail server, port, TLS flag, user, and sender address. A saved value overrides the environment. The mail password stays in the environment. A reset deletes that user's local sessions after the password is saved. An `invited` row is never activated by an AuthKit email match. `/local-accept` posts the invite token to `POST /api/v1/auth/invite/start`, which holds it in a 15-minute httpOnly `cuttlely-invite` cookie and sends the browser to AuthKit. The callback then uses the token once, for that user and that verified mailbox, sets the user `active`, and binds the AuthKit id, in one transaction (`acceptAuthKitInvite` in `actionLink.ts`). Without the token the callback answers `You have a pending invite. Open the invite link from your email to join.` Enabling a user never activates a pending invite. Removing or disabling one marks its open invite tokens used. `POST /api/v1/users/:id/reset-link` on a pending user issues a new invite link. `GET /api/v1/auth/signin-options` returns `{ authKit, localAdmin, localUsers, mail, ownerRecovery }` with no secrets. The sign-in page shows WorkOS and ordinary local login when configured and always shows a discreet **Owner recovery** link. `localUsers` is true only when `CUTTLELY_LOCAL_USERS` is exactly `true` and AuthKit is not configured. `POST /api/v1/auth/local/login`, `POST /api/v1/auth/local/logout`, and `POST /api/v1/auth/local/password` are that mode. The person sets their own password from the one-time link (`POST /api/v1/auth/local/accept`). No route sets another user's password directly. `GET /api/v1/auth/permissions/ROLE` and `GET /api/v1/auth/permissions/API_KEY` return the permission catalogs.

Phase 6 stops SSO provider modules and Stripe quota fetches on the Apache boot path. Quota helpers return without reading a subscription. `POST /api/v1/account/register` is 404 when `CUTTLELY_LOCAL_ADMIN` is off, including from loopback. Forgot-password, reset-password, resend-verification, confirm-email-change, verify, and billing are 404. Datasets, evaluations, and evaluators stay mounted and answer 403. `GET /api/v1/pricing` answers 404.

Phase 7 deletes the commercial tree. `initAuthSecrets` in this module loads JWT and session values from the environment, then from a file under `SECRETKEY_PATH`. AuthKit does not read those values. Boot uses `ossIdentity()` with no cast to a commercial manager. Apache routes use `requirePermission` and `requireAnyPermission`. Export, import, organization, and login methods answer 404. `POST /api/v1/audit/login-activity` answers 404. `GET /api/v1/audit` is the audit log. The BullMQ dashboard is not mounted; `/admin/queues` answers 404 when queue mode and the dashboard flag are both set. Cuttlely does not run queue mode.
