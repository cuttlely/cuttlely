<!--
Copyright 2026 The Cuttlely Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
-->

# Choose the sign-in method

Open **Admin** > **Auth / SSO** to see the method used for ordinary sign-in. The page is available to an owner or a role with **Authentication: Manage**.

This release supports **Local login** and **WorkOS**. Their existing environment settings remain authoritative. Generic OIDC and SCIM are shown as unavailable and cannot be configured yet.

## Change the method

1. Configure the candidate method through the existing server settings.
2. Choose **Sign in again** and complete a fresh sign-in. A local password sign-in records fresh authentication on the server for 10 minutes. A WorkOS reauthentication records it only when WorkOS proves that the authentication time is at or after the request. If it cannot, use **Owner recovery** on the sign-in page. A successful owner recovery sign-in also records recent authentication for 10 minutes. An ordinary older session never satisfies the requirement. Both staging and applying the change require fresh authentication, so sign in again if more than 10 minutes pass before you apply.
3. Select the method and choose **Review change**.
4. Read the impact statement, type `END SESSIONS`, and apply the change.

Applying a different method ends every interactive session, including yours. API keys remain enabled. The browser returns to sign-in after the database transaction commits. Choosing the already-active method does not end sessions.

## Owner recovery

The separate `/owner-recovery` page is always available, regardless of the selected ordinary sign-in method or WorkOS health. It accepts only an active owner's local password and creates the same Cuttlely database session used by every other sign-in method. `CUTTLELY_LOCAL_ADMIN` is not required for this page. The older owner route continues to follow that setting for compatibility.

Recovery currently uses a password only; it does not add a second factor. Treat the password as an emergency credential, store it with the same care as other operator credentials, and test it periodically. To create or replace it, run `pnpm user --email owner@example.com` on the server and enter the password at the prompt.

WorkOS activation returns `409 Conflict` until at least one active owner has a usable local password. Switching from WorkOS to Local login has the same requirement, checked during staging and again in the switch transaction. The **Auth / SSO** page and application banner show when recovery is not ready.

Every recovery attempt creates a high-severity audit entry for success, wrong credentials, or throttling. A success also writes a structured warning and creates an administrator alert shown on **Auth / SSO** and in the application banner. When SMTP is configured, the server makes a best-effort attempt to email every active owner; an email delivery problem does not undo the recovery sign-in or alert. A user with **Authentication: Manage** must acknowledge the alert; that acknowledgment is audited.

To offboard an owner manually, open **Admin** > **Users** while signed in as another owner and either disable the account or change its role. Disabling it ends its interactive sessions and refuses its owned API credentials on the next request. Keys created before 1.5.0 without a recorded owner are not tied to a user; the API Keys page marks them for review or rotation. Confirm that another active owner has a tested local password before removing the last recovery-ready owner. SCIM cannot perform this owner offboarding in this release.

## Sessions and account status

Local login, WorkOS, and owner recovery all create a Cuttlely database session and the `cuttlely-local-session` browser cookie. WorkOS sealed values are not application session credentials. Logout deletes the database session and clears the session cookies before any best-effort WorkOS sign-out request.

The switch transaction increments the authentication epoch and ends every interactive database session while leaving API keys enabled. Each process refreshes the durable method and epoch at most two seconds after its cached read, and session issuance checks the database epoch again before completion. A request that began under an older epoch cannot finish by creating a new session on another process.

Every database-session request and every owned API credential request reads the current user status. A disabled user is refused on the next call. WorkOS deactivation by itself does not immediately change the Cuttlely user row: automatic IdP deactivation requires SCIM, planned for Phase C. Until then, disable the user in Cuttlely or wait for the session to expire.

The staged confirmation is stored in the database with a version, ten-minute expiry, and single-use marker. It can be applied by another application process; an expired, consumed, or stale-version stage is refused.

## Upgrade behavior

On the first start after upgrade, Cuttlely records a database installation id and infers the current method once:

-   A complete WorkOS configuration remains on WorkOS.
-   A complete WorkOS configuration with `CUTTLELY_LOCAL_USERS=true` also remains on WorkOS. The page reports the mixed settings for review, but automatic email linking and invitation sign-in continue normally.
-   Local-user mode remains on Local login.
-   An owner-only installation keeps recovery access without enabling ordinary local login.

On the first start with this release, Cuttlely writes one database cutoff marker. Everyone whose browser still has the older sealed WorkOS session signs in again once. The old cookie is cleared and is never exchanged into a Cuttlely session. Existing local-user sessions are unchanged, and API keys continue working. Repeated starts reuse the marker and do not repeat the cutoff.

Only a saved WorkOS client identity that differs from the current client identity pauses automatic email linking, including the email linking used to accept an invitation. Existing durable WorkOS subject links can still sign in. An administrator must complete a fresh sign-in and explicitly acknowledge that warning on **Auth / SSO**. The confirmation states that the action ends every interactive session, including the administrator's session, so everyone must sign in again. The audited action advances the authentication epoch, records the time and number of sessions ended, accepts the current configuration fingerprint, and enables automatic email and invitation linking again. Other configuration warnings are informational and do not pause linking. Compatibility sign-in, callback, refresh, resolve, logout, and settings routes remain available for this minor release line.

`TOKEN_HASH_SECRET` supplies separate derived material for authentication epoch binding and reauthentication state. It also binds chat-session ownership, file-download links, setup codes, flow-check cursors and their searches, and email-based login lockout identifiers. Changing `TOKEN_HASH_SECRET` means existing values for each of those uses no longer match. Client-address lockout rows and database session token digests are independent of it. When `TOKEN_HASH_SECRET` is unset, Cuttlely uses its persisted instance fallback.

To rotate `TOKEN_HASH_SECRET`, set the same `TOKEN_HASH_SECRET` on the server and every worker, then restart them together. Outstanding WorkOS epoch bindings and reauthentication requests, chat ownership tokens, signed file-download URLs, setup codes, flow-check cursors and search tokens, and stored email lockout identifiers made with the previous value no longer validate. Current database sign-in sessions continue because their token digests do not use `TOKEN_HASH_SECRET`. To end every interactive session, change the selected method under **Admin** > **Auth / SSO**; to end sessions for one person, use **Admin** > **Users** > **Sessions**.

Method-change and client-identity acknowledgment audit rows include the configuration fingerprint, session count, and outcome. Refused and failed apply attempts are recorded without secret values.
