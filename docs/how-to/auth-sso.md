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
2. Choose **Sign in again** and complete a fresh sign-in. A local password sign-in, the dedicated WorkOS reauthentication callback, or owner recovery sign-in records fresh authentication on the server for 10 minutes. An ordinary WorkOS sign-in and a valid older session do not satisfy this requirement. Both staging and applying the change require it, so sign in again if more than 10 minutes pass before you apply.
3. Select the method and choose **Review change**.
4. Read the impact statement, type `END SESSIONS`, and apply the change.

Applying a different method ends every interactive session, including yours. API keys remain enabled. The browser returns to sign-in after the database transaction commits. Choosing the already-active method does not end sessions.

Phase A does not enable a new recovery route or change sign-in behavior. Until the existing recovery route is enabled and an active owner has a usable password, administrators see a blocking warning on **Auth / SSO** and an application banner. The exact server-side fix is to enable `CUTTLELY_LOCAL_ADMIN`, then run `pnpm user --email` on the server to create the owner recovery credential. Do not put the password in an environment variable or command argument.

Panel activation of WorkOS continues to return `409 Conflict` until both recovery conditions are true. The warning does not claim that an operator retains the password or that a later server-side setting or account change cannot make recovery unavailable. The separate, always-available break-glass route starts in phase B.

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
