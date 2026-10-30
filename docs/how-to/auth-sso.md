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
2. Sign in again if the page asks for recent authentication. An owner recovery sign-in also satisfies this requirement.
3. Select the method and choose **Review change**.
4. Read the impact statement, type `END SESSIONS`, and apply the change.

Applying a different method ends every interactive session, including yours. API keys remain enabled. The browser returns to sign-in after the database transaction commits. Choosing the already-active method does not end sessions.

The owner recovery route remains available regardless of the selected method and cannot be disabled from this page. Keep an owner credential usable before relying on remote sign-in.

## Upgrade behavior

On the first start after upgrade, Cuttlely records a database installation id and infers the current method once:

-   A complete WorkOS configuration remains on WorkOS.
-   Local-user mode remains on Local login.
-   An owner-only installation keeps recovery access without enabling ordinary local login.

The prior one-time WorkOS cutoff record is imported, so an upgrade does not repeat session deletion. If the saved WorkOS identity differs from the current client identity, the page shows a warning for administrator review. Existing sign-in routes, cookies, invitations, and settings continue unchanged.
