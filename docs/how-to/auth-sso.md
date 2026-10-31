<!--
Copyright 2026 The Cuttlely Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
-->

# Choose the sign-in method

Open **Admin** > **Auth / SSO** to see the method used for ordinary sign-in. The page is available to an owner or a role with **Authentication: Manage**.

The available methods are **Local login**, **Generic OIDC**, and **WorkOS**. The durable active method controls ordinary sign-in; the WorkOS and local settings remain available when their method is selected. SCIM is not available yet.

## Set up generic OIDC

1. Open **Admin** > **Auth / SSO**. Enter the exact issuer URL, client id, and the environment variable name. The card starts with `CUTTLELY_OIDC_CLIENT_SECRET`. Set that variable on every server.
2. Register the callback URL and post-logout URL shown on the card with the identity provider. The requested scopes are fixed to `openid email profile`.
3. Save the draft. Cuttlely reads provider metadata through its guarded outbound request path, without following redirects. The card shows a sanitized status and the last check time.
4. Choose **Test sign-in** in the same administrator browser. The test expires after ten minutes, is single use, creates no application session, and does not change the active method. A successful result shows the returned email and assurance basis.
5. Choose **Activate**, review the session impact, type `END SESSIONS`, and apply.

Activation returns `409 Conflict` until the current configuration fingerprint has passed a test, owner recovery is ready, and the provider-link migration has completed. The callback URL comes from trusted server configuration, not request forwarding headers.

Set `APP_URL` to the public origin before testing or activating OIDC. It must use HTTPS. For local development, HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1`. When the origin uses HTTPS, the OIDC browser cookie and the application session cookie are both Secure.

The shipped Compose files pass `APP_URL` and `CUTTLELY_OIDC_CLIENT_SECRET` into the server. If the setup card names a different environment variable, add that exact name to the Compose service's `environment` section as well.

Issuer and token endpoints must use HTTPS. For local testing only, HTTP is accepted when the issuer host is loopback and that exact host is in **Private issuer hosts**. Public addresses remain usable without this list. An exact listed host, including `localhost` or `ip6-localhost`, may also resolve to `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, or `fc00::/7`. It may not resolve to the unspecified addresses `0.0.0.0` or `::`; the link-local ranges `169.254.0.0/16` or `fe80::/10`; the multicast ranges `224.0.0.0/4` or `ff00::/8`; the reserved range `240.0.0.0/4`; or `255.255.255.255`. The specific service addresses `100.100.100.200`, `169.254.169.253`, `169.254.169.254`, `192.0.0.192`, and `fd00:ec2::254` stay refused. An `::ffff:` address follows the decision for its embedded IPv4 address. Every DNS answer is checked, the chosen address is pinned, unrelated hosts remain blocked, and `HTTP_DENY_LIST` still wins. Use the list only for an identity provider you operate.

The **Trust issuer email when the verification claim is missing** option is off by default. With it off, first linking requires `email_verified=true`. `xms_edov=true` also qualifies when the issuer uses HTTPS and its exact host is `login.microsoftonline.com`, `login.microsoftonline.us`, `login.chinacloudapi.cn`, or `login.partner.microsoftonline.cn`. With the option on, a missing verification claim may qualify; an explicit `email_verified=false` never does. Cuttlely takes the email and its assurance from one source. It uses the ID-token claims when that token contains an email and either `email_verified` or a qualifying `xms_edov=true`. Otherwise, when the provider publishes a UserInfo endpoint, it uses the UserInfo claims only after `sub` matches the ID token. It never combines an email from one response with assurance from the other. An explicit false for the selected email keeps it unverified.

OIDC authorization transactions use a purpose-specific value derived from `TOKEN_HASH_SECRET`; there is no separate OIDC transaction setting. Every sign-in start also creates a fresh ten-minute, HttpOnly, SameSite=Lax browser cookie that is limited to the callback path. The transaction stores only its digest. The callback consumes the transaction and expires the cookie, and a callback opened in another browser is refused without creating a session. Rotate `TOKEN_HASH_SECRET` on every server together. That rotation ends sign-ins already in progress, along with the other server data already tied to `TOKEN_HASH_SECRET`. Changing the value named by the setup card does not end application sessions because the configuration fingerprint uses the environment variable name, not its value. Changing the issuer, client id, environment variable name, trust option, or private-host allowlist produces a new fingerprint and requires another test and activation.

OIDC request limits are kept separately by each server process. In a 15-minute window, one process allows 600 ordinary starts, 300 reauthentication starts, and 1,200 callbacks per client address. It also keeps one shared 20-failure limit for all start paths and a separate 20-failure limit for callbacks. Admin configuration writes and test starts each allow 10 requests. A restart clears these process-local counts. With several replicas, each replica has its own complete set of limits, so the effective total can be multiplied by the replica count. Configure `TRUST_PROXY` so the client address is read correctly behind a proxy.

### Identity linking

Cuttlely first looks up the issuer-specific subject link. After that link exists, email is profile data and may be absent. On a first sign-in, exactly one active local user must match the normalized email, the email must meet the assurance rule above, and no provider link may conflict. A valid one-time invitation is a separate basis: its normalized email must match, and an explicit `email_verified=false` is refused. The invitation is consumed in the same transaction that creates the provider link. A plain email match never activates a pending invitation. Removing a person's final organization membership tombstones that user and removes the subject link, so a later invitation can bind the same subject to the new account.

Disabling a person only at the identity provider does not immediately end an existing Cuttlely session in this phase. It takes effect when SCIM provisioning arrives in a later phase or when the existing idle or absolute session lifetime ends.

## Change the method

1. Configure the candidate method through the existing server settings.
2. Choose **Sign in again** and complete a fresh sign-in. A local password sign-in records fresh authentication on the server for 10 minutes. While generic OIDC is the active method, only a fresh OIDC reauthentication counts; a local or owner password sign-in does not. Until an owner recovery sign-in is available, do not activate generic OIDC in production, because a provider outage would leave no way to make a sensitive authentication change. OIDC requests `prompt=login` and `max_age=0`; the result counts as fresh only when the ID token includes `auth_time` no earlier than 60 seconds before the request began. A missing or older `auth_time` can still complete sign-in, but it does not authorize a sensitive change. A WorkOS reauthentication records it only when WorkOS proves that the authentication time is at or after the request. The current WorkOS integration cannot provide that proof, so a WorkOS sign-in alone does not satisfy this requirement; use the local owner password form at `/signin?reauth=1`. An ordinary remote sign-in and a valid older session never satisfy the requirement. Both staging and applying the change require fresh authentication, so sign in again if more than 10 minutes pass before you apply.
3. Select the method and choose **Review change**.
4. Read the impact statement, type `END SESSIONS`, and apply the change.

Applying a different method ends every interactive session, including yours. API access credentials remain enabled. The browser returns to sign-in after the database transaction completes. Applying a tested OIDC draft that is identical to the active configuration makes no change and does not end sessions.

Phase A does not enable a new recovery route or change sign-in behavior. Until the existing recovery route is enabled and an active owner has a usable password, administrators see a blocking warning on **Auth / SSO** and an application banner. The exact server-side fix is to enable `CUTTLELY_LOCAL_ADMIN`, then run `pnpm user --email owner@example.com` on the server to create the owner recovery credential. With Docker, run `docker compose exec cuttlely pnpm user --email owner@example.com`. Enter the password at the prompt.

Panel activation of WorkOS continues to return `409 Conflict` until both recovery conditions are true. Switching from WorkOS to Local login also returns `409 Conflict` unless at least one active owner has a usable local password; this is checked when the change is staged and again in the switch transaction. The warning does not claim that an operator retains the password or that a later server-side setting or account change cannot make recovery unavailable. The separate, always-available owner recovery route is outside this change.

The switch transaction increments the authentication epoch and ends interactive database sessions while leaving API keys enabled. A valid sealed WorkOS session from before Phase A, which has no epoch cookie, remains valid only while the current epoch matches the durable baseline recorded during upgrade; its first successful validation adds the epoch cookie. After any method switch, an epoch-less or stale epoch-bound sealed session is rejected, including after a WorkOS to Local login to WorkOS round trip. Session invalidation therefore does not depend on row deletion. Each process refreshes the durable method and epoch at most two seconds after its cached read, and session issuance checks the database epoch again before completion. A request that began under an older epoch cannot finish by creating a new session on another process.

The staged confirmation is stored in the database with a version, ten-minute expiry, and single-use marker. It can be applied by another application process; an expired, consumed, or stale-version stage is refused.

## Upgrade behavior

On the first start after upgrade, Cuttlely records a database installation id and infers the current method once:

-   A complete WorkOS configuration remains on WorkOS.
-   A complete WorkOS configuration with `CUTTLELY_LOCAL_USERS=true` also remains on WorkOS. The page reports the mixed settings for review, but automatic email linking and invitation sign-in continue normally.
-   Local-user mode remains on Local login.
-   An owner-only installation keeps recovery access without enabling ordinary local login.

The durable method state is loaded before the prior one-time WorkOS cutoff is considered. After a panel switch, restart defers to that durable state and does not repeat session deletion.

Legacy `externalId` values are WorkOS subjects. When the upgraded installation has a stable WorkOS provider identity, Cuttlely copies those subjects into durable provider links before OIDC can be activated. When no stable WorkOS provider identity can be attributed, the subjects are recorded as unmigrated and inert instead; they cannot match a generic OIDC provider and do not block OIDC activation. **Auth / SSO** reports how many inert subjects remain.

Only a saved WorkOS client identity that differs from the current client identity pauses automatic email linking, including the email linking used to accept an invitation. Existing durable WorkOS subject links can still sign in. An administrator must complete a fresh sign-in and explicitly acknowledge that warning on **Auth / SSO**; that audited action accepts the current configuration fingerprint and enables automatic email and invitation linking again. Other configuration warnings are informational and do not pause linking. Existing sign-in routes, cookies, and settings otherwise continue unchanged.

Method-change audit rows include the configuration fingerprint, session count, and outcome. Refused and failed apply attempts are recorded without secret values.
