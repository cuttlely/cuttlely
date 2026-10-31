<!--
Copyright 2026 The Cuttlely Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
-->

# Choose the sign-in method

Open **Admin** > **Auth / SSO** to see the method used for ordinary sign-in. The page is available to an owner or a role with **Authentication: Manage**.

This release supports **Local login**, **Generic OIDC**, and **WorkOS**. Existing WorkOS and local settings remain authoritative. SCIM is not available yet.

## Set up generic OIDC

1. Set `CUTTLELY_OIDC_TRANSACTION_SECRET` on every Cuttlely server to the same value of at least 32 random bytes, then restart. This value encrypts authorization transactions for the ten minutes they can exist.
2. Open **Admin** > **Auth / SSO**. Enter the exact issuer URL, client id, and the name of the environment variable that contains the client secret. Cuttlely stores the environment variable name, never its value. Set that named variable on every server.
3. Register the callback URL and post-logout URL shown on the card with the identity provider. The requested scopes are fixed to `openid email profile`.
4. Save the draft. Cuttlely reads discovery and signing keys through its guarded outbound request path, without following redirects. The card shows a sanitized status and the last check time.
5. Choose **Test sign-in** in the same administrator browser. The test expires after ten minutes, is single use, creates no application session, and does not change the active method. A successful result shows the returned email and assurance basis.
6. Choose **Activate**, review the session impact, type `END SESSIONS`, and apply.

Activation returns `409 Conflict` until the current configuration fingerprint has passed a test, owner recovery is ready, and the provider-link migration has completed. The callback URL comes from trusted server configuration, not request forwarding headers.

Issuer and token endpoints must use HTTPS. For local testing only, HTTP is accepted when the issuer host is loopback and that exact host is in **Private issuer hosts**. An exact allowlisted host may resolve to loopback or a private address; address resolution is still checked and pinned, unrelated hosts remain blocked, and `HTTP_DENY_LIST` still wins. Use the allowlist only for an identity provider you operate.

The **Trust issuer email when the verification claim is missing** option is off by default. With it off, first linking requires `email_verified=true`. For an Entra ID issuer on `login.microsoftonline.com`, `xms_edov=true` also qualifies. With the option on, a missing verification claim may qualify; an explicit `email_verified=false` never does.

`CUTTLELY_OIDC_TRANSACTION_SECRET` is independent of the OIDC client secret. Rotate the transaction secret by updating every server together and restarting; only sign-ins already in progress stop working. Rotating the value in the client-secret environment variable does not end application sessions because the configuration fingerprint uses the environment variable name, not its value. Changing the issuer, client id, secret reference name, or trust option produces a new fingerprint and requires another test and activation.

### Identity linking

Cuttlely first looks up the issuer-specific subject link. After that link exists, email is profile data and may be absent. On a first sign-in, exactly one active local user must match the normalized email, the email must meet the assurance rule above, and no provider link may conflict. A valid one-time invitation is a separate basis: its normalized email must match, and an explicit `email_verified=false` is refused. The invitation is consumed in the same transaction that creates the provider link. A plain email match never activates a pending invitation.

Disabling a person only at the identity provider does not immediately end an existing Cuttlely session in this phase. It takes effect when SCIM provisioning arrives in a later phase or when the existing idle or absolute session lifetime ends.

## Change the method

1. Configure the candidate method through the existing server settings.
2. Choose **Sign in again** and complete a fresh sign-in. A local password sign-in records fresh authentication on the server for 10 minutes. A WorkOS reauthentication records it only when WorkOS proves that the authentication time is at or after the request. The current WorkOS integration cannot provide that proof, so a WorkOS sign-in alone does not satisfy this requirement; use the local owner password form at `/signin?reauth=1`. An ordinary WorkOS sign-in and a valid older session never satisfy the requirement. Both staging and applying the change require fresh authentication, so sign in again if more than 10 minutes pass before you apply.
3. Select the method and choose **Review change**.
4. Read the impact statement, type `END SESSIONS`, and apply the change.

Applying a different method ends every interactive session, including yours. API keys remain enabled. The browser returns to sign-in after the database transaction commits. Choosing the already-active method does not end sessions.

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

Only a saved WorkOS client identity that differs from the current client identity pauses automatic email linking, including the email linking used to accept an invitation. Existing durable WorkOS subject links can still sign in. An administrator must complete a fresh sign-in and explicitly acknowledge that warning on **Auth / SSO**; that audited action accepts the current configuration fingerprint and enables automatic email and invitation linking again. Other configuration warnings are informational and do not pause linking. Existing sign-in routes, cookies, and settings otherwise continue unchanged.

Method-change audit rows include the configuration fingerprint, session count, and outcome. Refused and failed apply attempts are recorded without secret values.
