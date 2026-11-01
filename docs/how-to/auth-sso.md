<!--
Copyright 2026 The Cuttlely Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
-->

# Choose the sign-in method

Open **Admin** > **Auth / SSO** to see the method used for ordinary sign-in. The page is available to an owner or a role with **Authentication: Manage**.

The available methods are **Local login**, **Generic OIDC**, and **WorkOS**. The durable active method controls ordinary sign-in; the WorkOS and local settings remain available when their method is selected. SCIM provisioning is not available in 1.4.10; it is planned.

## Set up generic OIDC

1. Open **Admin** > **Auth / SSO**. Enter the exact issuer URL, client id, and the environment variable name. The card starts with `CUTTLELY_OIDC_CLIENT_SECRET`. Set that variable on every server, then save the draft.
2. Register the exact **Draft callback URL** shown after the draft is saved. If a provider is already active, keep the separate **Active callback URL** registered until the new draft is activated. The two URLs differ when the draft changes the issuer or client id; after activation, the draft URL becomes the active URL. When there is no draft, the card still shows the active URL. The requested scopes are fixed to `openid email profile`.
3. The save reads provider metadata through the guarded outbound request path, without following redirects. The card shows a sanitized status and the last check time. It also attempts an `auth_config_change` audit row, including when the provider check returns an error. An audit write problem does not undo the saved draft.
4. Choose **Test sign-in** in the same administrator browser. The test expires after ten minutes, is single use, creates no application session or provider link, and does not change the active method. It passes only when the returned identity would be accepted by ordinary sign-in: an existing subject link must lead to an active user, or the assured email must match exactly one active Cuttlely user. A refused identity shows the reason and clears any earlier pass for that draft. A successful result shows the returned email and assurance basis.
5. Choose **Activate**, review the session impact, type `END SESSIONS`, and apply.

A provider denial or a failure during provider exchange, ID-token checking, or UserInfo also clears an earlier test pass for that draft. Activation and refreshed-provider apply remain unavailable until a later test passes.

Activation returns `409 Conflict` until the current configuration fingerprint has passed the identity acceptance check, owner recovery is ready, and the provider-link migration has completed. Drafts tested by an earlier release must be tested again. The callback URL comes from trusted server configuration, not request forwarding headers.

If the issuer and client id stay the same but discovery changes an endpoint, JWKS location, or signing algorithm, save and test the draft again. **Apply refreshed provider settings** then copies the tested provider snapshot into the active configuration and records `auth_config_change` with outcome `applied_to_active`. Existing sessions stay signed in, and the authentication epoch does not change. The action appears only when the tested draft differs from the active configuration; applying the same snapshot again makes no change.

Each configured provider has a distinct callback URL whose final path segment is the provider marker. The URL has no query parameters. The callback must match the sign-in transaction before Cuttlely sends the authorization code to the token endpoint. When an authorization response contains `iss`, Cuttlely requires it to match the transaction issuer. When provider metadata advertises the authorization-response issuer parameter, a response without `iss` is refused.

For token endpoint client authentication, Cuttlely uses `client_secret_basic` when provider metadata advertises it or omits the supported-method list. It uses `client_secret_post` when that is the only supported secret method. When both are advertised and the first request returns `invalid_client` with HTTP 400 or 401, Cuttlely retries once with `client_secret_post`. Other errors are not retried.

Set `APP_URL` to the public origin before testing or activating OIDC. It must use HTTPS. For local development, HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1`. When the origin uses HTTPS, the OIDC browser cookie and the application session cookie are both Secure.

The shipped Compose files pass `APP_URL` and `CUTTLELY_OIDC_CLIENT_SECRET` into the server. If the setup card names a different environment variable, add that exact name to the Compose service's `environment` section as well.

Issuer and token endpoints must use HTTPS. For local testing only, HTTP is accepted when the issuer host is loopback and that exact host is in **Private issuer hosts**. Public addresses remain usable without this list. An exact listed host, including `localhost` or `ip6-localhost`, may also resolve to `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, or `fc00::/7`. It may not resolve to the unspecified addresses `0.0.0.0` or `::`; the link-local ranges `169.254.0.0/16` or `fe80::/10`; the multicast ranges `224.0.0.0/4` or `ff00::/8`; the reserved range `240.0.0.0/4`; or `255.255.255.255`. The specific service addresses `100.100.100.200`, `169.254.169.253`, `169.254.169.254`, `192.0.0.192`, and `fd00:ec2::254` stay refused. An `::ffff:` address follows the decision for its embedded IPv4 address. Every DNS answer is checked, the chosen address is pinned, unrelated hosts remain blocked, and `HTTP_DENY_LIST` still wins. Use the list only for an identity provider you operate.

The **Trust issuer email when the verification claim is missing** option is off by default. With it off, first linking requires `email_verified=true`. `xms_edov=true` also qualifies when the issuer uses HTTPS and its exact host is `login.microsoftonline.com`, `login.microsoftonline.us`, `login.chinacloudapi.cn`, or `login.partner.microsoftonline.cn`. With the option on, a missing verification claim may qualify; an explicit `email_verified=false` never does. Cuttlely takes the email and its assurance from one source. It uses the ID-token claims when that token contains an email and either `email_verified` or a qualifying `xms_edov=true`. Otherwise, when the provider publishes a UserInfo endpoint, it uses the UserInfo claims only after `sub` matches the ID token. It never combines an email from one response with assurance from the other. An explicit false for the selected email keeps it unverified.

OIDC authorization transactions use a purpose-specific value derived from `TOKEN_HASH_SECRET`; there is no separate OIDC transaction setting. Every sign-in start also creates a fresh ten-minute, HttpOnly, SameSite=Lax browser cookie that is limited to the callback path. The transaction stores only its digest. The callback consumes the transaction and expires the cookie, and a callback opened in another browser is refused without creating a session. Rotate `TOKEN_HASH_SECRET` on every server together. That rotation ends sign-ins already in progress, along with the other server data already tied to `TOKEN_HASH_SECRET`. Changing the value named by the setup card does not end application sessions because the configuration fingerprint uses the environment variable name, not its value. Changing the issuer, client id, environment variable name, trust option, or private-host allowlist produces a new fingerprint and requires another test and activation.

OIDC request limits are kept separately by each server process. In a 15-minute window, one process allows 600 ordinary starts, 300 reauthentication starts, 120 invitation starts, and 1,200 callbacks per client address. Ordinary, reauthentication, and invalid invitation starts share one 20-failure limit. The separate 20-failure callback limit is charged only after the transaction and browser binding match, and only for invalid authorization-response binding (a callback or issuer mismatch, or a missing code), ID-token validation failure, UserInfo subject mismatch, or a token endpoint `invalid_grant` response. Provider-returned errors, provider or token-endpoint outages, network or other upstream errors, discovery or JWKS fetch failures, unavailable or changed configuration, session creation failures, a reauthentication account mismatch, unexpected errors, and identity-link policy refusals of a validly signed-in identity, such as an unprovisioned user or a domain that is not allowed, do not count. An unknown or expired state and a browser-binding failure remain under the 1,200-callback route limit only. Admin configuration writes and test starts each have their own 10-request limit; test starts do not use the shared start-failure limit. A restart clears these process-local counts. With several replicas, each replica has its own complete set of limits, so the effective total can be multiplied by the replica count. Configure `TRUST_PROXY` so the client address is read correctly behind a proxy.

### Identity linking

Cuttlely first looks up the issuer-specific subject link. After that link exists, email is profile data and may be absent. On a first sign-in, exactly one active local user must match the normalized email, the email must meet the assurance rule above, and no provider link may conflict. A valid one-time invitation is a separate basis: its normalized email must match, and an explicit `email_verified=false` is refused. The invitation is consumed in the same transaction that creates the provider link. A plain email match never activates a pending invitation. Removing a person's final organization membership tombstones that user and removes the subject link, so a later invitation can bind the same subject to the new account.

Disabling a person only at the identity provider does not end an existing Cuttlely session. SCIM provisioning is planned and is not part of 1.4.10. Until then, disable the person in **Admin** > **Users**, or the session ends when its idle or absolute lifetime runs out.

The Local login choice says **owner only** when `CUTTLELY_LOCAL_ADMIN=true` provides ordinary sign-in for the owner, and **local users** when `CUTTLELY_LOCAL_USERS=true` provides sign-in for active local users with passwords. Owner-only Local remains visible, but changing from another method to Local requires `CUTTLELY_LOCAL_USERS=true`. The local directory routes also require that setting and Local as the durable selected method.

On a fresh owner-only install, creating the first owner through browser setup or `pnpm user` selects Local login in the owner-creation transaction. A durable method that is already selected is left unchanged, including WorkOS.

## Change the method

1. Configure the candidate method through the existing server settings. Before changing to Local, set `CUTTLELY_LOCAL_USERS=true` and restart.
2. Complete a fresh local password sign-in, owner recovery, or qualifying OIDC reauthentication. While Local login is active, choose **Sign in again** to use the local password form. While WorkOS is active, choose **Use Owner recovery**. While generic OIDC is active, **Sign in again** requests `prompt=login` and `max_age=0`; it counts only when the ID token has an `auth_time` no earlier than 60 seconds before the request began. A missing or older `auth_time` can complete sign-in but cannot authorize the change. A fresh owner recovery session also counts while OIDC is active. A WorkOS sign-in does not count. Local password and owner recovery sessions count for 10 minutes, with future-issued timestamps refused. Both staging and applying require recent authentication, so repeat the step if more than 10 minutes pass before applying.
3. Select the method and choose **Review change**.
4. Read the impact statement, type `END SESSIONS`, and apply the change.

Applying a different method ends every interactive session, including yours. API access credentials remain enabled. The browser returns to sign-in after the database transaction completes. Applying refreshed provider settings for the active OIDC method keeps sessions and the authentication epoch unchanged. Applying the same tested snapshot again makes no change.

## Owner recovery

The separate `/owner-recovery` page is always available, regardless of the selected ordinary sign-in method or remote provider health. It accepts only an active owner's local password and creates the same Cuttlely database session used by every other sign-in method. `CUTTLELY_LOCAL_ADMIN` is not required for this page. The older owner route continues to follow that setting for compatibility: it is an ordinary Local sign-in while Local is active, and uses recovery treatment under another active method.

Recovery currently uses a password only; it does not add a second factor. Treat the password as an emergency credential, store it with the same care as other operator credentials, and test it periodically. To create or replace it, run `pnpm user --email owner@example.com` on the server and enter the password at the prompt.

WorkOS activation returns `409 Conflict` until at least one active owner has a usable local password. Changing from WorkOS to Local login requires both `CUTTLELY_LOCAL_USERS=true` and an active owner with a usable local password. Those requirements are checked during staging and again in the change transaction. The **Auth / SSO** page and application banner show when recovery is not ready.

Every recovery attempt creates a high-severity audit entry for success, wrong credentials, or throttling. A success also writes a structured warning and creates an administrator alert shown on **Auth / SSO** and in the application banner. When SMTP is configured, the server makes a best-effort attempt to email every active owner; an email delivery problem does not undo the recovery sign-in or alert. A user with **Authentication: Manage** must acknowledge the alert; that acknowledgment is audited.

To offboard an owner manually, open **Admin** > **Users** while signed in as another owner and either disable the account or change its role. Disabling it ends its interactive sessions and refuses its owned API credentials on the next request. API credentials created before 1.4.9 have no recorded owner and are not tied to a user; the API credentials list marks them for review or rotation. Confirm that another active owner has a tested local password before removing the last recovery-ready owner. SCIM provisioning is not part of 1.4.10.

## Sessions and account status

Local login, generic OIDC, WorkOS, and owner recovery all create a Cuttlely database session and the `cuttlely-local-session` browser cookie. A WorkOS session also keeps its provider session id on the server. Sign-out deletes the database session first. A WorkOS session then redirects through the hosted logout URL and returns to the origin of `WORKOS_REDIRECT_URI` plus `/signin`; Local, OIDC, and recovery sessions go directly to `/signin`. If the hosted URL cannot be created, the local session is still gone and the browser goes to `/signin`. Sealed browser values are not application sessions.

The switch transaction increments the authentication epoch and ends every interactive database session while leaving API keys enabled. Each process refreshes the durable method and epoch at most two seconds after its cached read, and session issuance checks the database epoch again before completion. A request that began under an older epoch cannot finish by creating a new session on another process.

Every database-session request and every owned API credential request reads the current user status. A disabled user is refused on the next call. WorkOS deactivation by itself does not immediately change the Cuttlely user row: automatic IdP deactivation needs SCIM provisioning, which is planned and is not part of 1.4.10. Until then, disable the user in Cuttlely or wait for the session to expire.

The staged confirmation is stored in the database with a version, ten-minute expiry, and single-use marker. It can be applied by another application process; an expired, consumed, or stale-version stage is refused. Staging and applying each allow 10 requests per client address in 15 minutes; more return 429 with `{ "type": "authentication_rate_limit" }`. These request limits are counted in each server process: with several replicas behind a load balancer, each replica keeps its own count, and a restart resets it. The durable stage record, not the request limit, is what keeps a switch single-use.

## Upgrade behavior

On the first start after upgrade, Cuttlely records a database installation id and infers the current method once:

-   A complete WorkOS configuration remains on WorkOS.
-   A complete WorkOS configuration with `CUTTLELY_LOCAL_USERS=true` also remains on WorkOS. The page reports the mixed settings for review, but automatic email linking and invitation sign-in continue normally.
-   Local-user mode remains on Local login.
-   An owner-only installation keeps recovery access without enabling ordinary local login.

On the first start with this release, Cuttlely writes one database cutoff marker. Everyone whose browser still has the older sealed WorkOS session signs in again once. The old cookie is cleared and is never exchanged into a Cuttlely session. Existing local-user sessions are unchanged, and API keys continue working. Repeated starts reuse the marker and do not repeat the cutoff.

Legacy `externalId` values are WorkOS subjects. When the upgraded installation has a stable WorkOS provider identity, Cuttlely copies those subjects into durable provider links before OIDC can be activated. When no stable WorkOS provider identity can be attributed, the subjects are recorded as unmigrated and inert instead; they cannot match a generic OIDC provider and do not block OIDC activation. **Auth / SSO** reports how many inert subjects remain.

Only a saved WorkOS client identity that differs from the current client identity pauses automatic email linking, including the email linking used to accept an invitation. Existing durable WorkOS subject links can still sign in. An administrator must complete a fresh sign-in and explicitly acknowledge that warning on **Auth / SSO**. The confirmation states that the action ends every interactive session, including the administrator's session, so everyone must sign in again. The audited action advances the authentication epoch, records the time and number of sessions ended, accepts the current configuration fingerprint, and enables automatic email and invitation linking again. Other configuration warnings are informational and do not pause linking. Compatibility sign-in, callback, refresh, resolve, logout, and settings routes remain available for this minor release line.

`TOKEN_HASH_SECRET` supplies derived material for authentication epoch binding. It also binds chat-session ownership, file-download links, setup codes, flow-check cursors and their searches, and email-based login lockout identifiers. Changing `TOKEN_HASH_SECRET` means existing values for each of those uses no longer match. Client-address lockout rows and database session token digests are independent of it. When `TOKEN_HASH_SECRET` is unset, Cuttlely uses its persisted instance fallback.

To rotate `TOKEN_HASH_SECRET`, set the same `TOKEN_HASH_SECRET` on the server and every worker, then restart them together. Outstanding WorkOS epoch bindings, chat ownership tokens, signed file-download URLs, setup codes, flow-check cursors and search tokens, and stored email lockout identifiers made with the previous value no longer validate. Current database sign-in sessions continue because their token digests do not use `TOKEN_HASH_SECRET`. To end every interactive session, change the selected method under **Admin** > **Auth / SSO**; to end sessions for one person, use **Admin** > **Users** > **Sessions**.

Method-change and client-identity acknowledgment audit rows include the configuration fingerprint, session count, and outcome. Refused and failed apply attempts are recorded without secret values.
