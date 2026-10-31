<!--
Copyright 2026 The Cuttlely Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
-->

# Choose the sign-in method

Open **Admin** > **Auth / SSO** to see the method used for ordinary sign-in. The page is available to an owner or a role with **Authentication: Manage**.

This release supports **Local login** and **WorkOS**. Their existing environment settings remain authoritative. Generic OIDC is not available yet. SCIM user provisioning is configured separately on this page.

The Local login choice says **owner only** when `CUTTLELY_LOCAL_ADMIN=true` provides ordinary sign-in for the owner, and **local users** when `CUTTLELY_LOCAL_USERS=true` provides sign-in for active local users with passwords. Owner-only Local remains visible, but changing from another method to Local requires `CUTTLELY_LOCAL_USERS=true`. The local directory routes also require that setting and Local as the durable selected method.

On a fresh owner-only install, creating the first owner through browser setup or `pnpm user` selects Local login in the owner-creation transaction. A durable method that is already selected is left unchanged, including WorkOS.

## Change the method

1. Configure the candidate method through the existing server settings. Before changing to Local, set `CUTTLELY_LOCAL_USERS=true` and restart.
2. Complete a fresh local password sign-in or owner recovery. While Local login is active, choose **Sign in again** to use the local password form. While WorkOS is active, choose **Use Owner recovery**. A WorkOS sign-in never counts as recent authentication. A local password or owner recovery session counts for 10 minutes; an older session never satisfies the requirement. Both staging and applying the change require recent authentication, so repeat the local password or owner recovery sign-in if more than 10 minutes pass before you apply.
3. Select the method and choose **Review change**.
4. Read the impact statement, type `END SESSIONS`, and apply the change.

Applying a different method ends every interactive session, including yours. API keys remain enabled. The browser returns to sign-in after the database transaction commits. Choosing the already-active method does not end sessions.

## Owner recovery

The separate `/owner-recovery` page is always available, regardless of the selected ordinary sign-in method or WorkOS health. It accepts only an active owner's local password and creates the same Cuttlely database session used by every other sign-in method. `CUTTLELY_LOCAL_ADMIN` is not required for this page. The older owner route continues to follow that setting for compatibility: it is an ordinary Local sign-in while Local is active, and uses recovery treatment under another active method.

Recovery currently uses a password only; it does not add a second factor. Treat the password as an emergency credential, store it with the same care as other operator credentials, and test it periodically. To create or replace it, run `pnpm user --email owner@example.com` on the server and enter the password at the prompt.

WorkOS activation returns `409 Conflict` until at least one active owner has a usable local password. Changing from WorkOS to Local login requires both `CUTTLELY_LOCAL_USERS=true` and an active owner with a usable local password. Those requirements are checked during staging and again in the change transaction. The **Auth / SSO** page and application banner show when recovery is not ready.

Every recovery attempt creates a high-severity audit entry for success, wrong credentials, or throttling. A success also writes a structured warning and creates an administrator alert shown on **Auth / SSO** and in the application banner. When SMTP is configured, the server makes a best-effort attempt to email every active owner; an email delivery problem does not undo the recovery sign-in or alert. A user with **Authentication: Manage** must acknowledge the alert; that acknowledgment is audited.

To offboard an owner manually, open **Admin** > **Users** while signed in as another owner and either disable the account or change its role. Disabling it ends its interactive sessions and disables its owned API credentials. Keys created before 1.5.0 without a recorded owner are not tied to a user; the API Keys page marks them for review or rotation. Confirm that another active owner has a tested local password before removing the last recovery-ready owner. SCIM can deactivate an owner only while another active owner remains.

## Sessions and account status

Local login, WorkOS, and owner recovery all create a Cuttlely database session and the `cuttlely-local-session` browser cookie. A WorkOS session also keeps its provider session id on the server. Sign-out deletes the database session first. A WorkOS session then redirects through the hosted logout URL and returns to the origin of `WORKOS_REDIRECT_URI` plus `/signin`; Local and recovery sessions go directly to `/signin`. If the hosted URL cannot be created, the local session is still gone and the browser goes to `/signin`. Sealed browser values are not application sessions.

The switch transaction increments the authentication epoch and ends every interactive database session while leaving API keys enabled. Each process refreshes the durable method and epoch at most two seconds after its cached read, and session issuance checks the database epoch again before completion. A request that began under an older epoch cannot finish by creating a new session on another process.

Every database-session request and every owned API credential request reads the current user status. A disabled user is refused on the next call. A SCIM deactivation also deletes every interactive session and disables every owned API key and personal token in the same database transaction. Enabling the user again does not restore those credentials.

## SCIM provisioning

On **Admin** > **Auth / SSO**, the **SCIM provisioning** card shows the base URL, credential status, display prefix, creator, creation time, and last-used time. Choose **Create** after a fresh sign-in, then copy the clear credential from the one-time display. Cuttlely stores only a keyed digest and never shows that clear value again.

Use **Rotate** to create a replacement. Choose no overlap or an overlap of 1, 4, or 24 hours. During overlap either value works; **End previous now** closes the overlap immediately. **Revoke** ends all SCIM access. Create, rotate, overlap end, and revoke require a fresh sign-in and are request-limited.

Configure the identity provider with the displayed base URL, ending in `/api/v1/scim/v2`, and bearer authentication. The service supports User create, read, list, replace, patch, deactivate, and delete. List filters support `eq` with `and`, `or`, and parentheses for `userName`, `externalId`, and `displayName`. A connection probe for an unknown `userName` or `externalId` returns an empty list.

`DELETE /Users/{id}` keeps the internal account disabled for audit and ownership records, removes its provider group memberships, and removes the SCIM resource from reads and lists. A later create with the same `userName` restores that resource id and account, but not its previous group memberships or mapped team access. Its old sessions, API keys, and personal tokens remain disabled. Deactivating or deleting the last active owner returns `409 Conflict` without changing the account or its credentials. See the [SCIM API](../reference/scim-api.md).

### Okta setup

1. In the application integration, enable SCIM 2.0 provisioning and paste the Cuttlely base URL as the SCIM connector base URL.
2. Select HTTP Header authentication and paste the one-time credential from Cuttlely.
3. Test the connection, then enable create, update, deactivate, and group push as needed.
4. Push a group only after its users are assigned to the application. Cuttlely accepts member add, full replacement, and `Remove` with `members[value eq "id"]`.

### Entra ID setup

1. In the enterprise application's Provisioning page, choose automatic provisioning.
2. Paste the Cuttlely base URL as the tenant URL and paste the one-time credential in the authentication field.
3. Test the connection, review the default user and group attribute mappings, choose the assigned scope, and start provisioning.
4. Cuttlely accepts capitalized patch operations, string `"False"` for `active`, member Add and Remove value arrays, and group reads with `excludedAttributes=members`.

The recorded CI fixtures follow the published request examples from both providers. They are compatibility tests, not vendor certification.

### Groups, mappings, and deprovisioning

Groups use `displayName`, optional `externalId`, and members whose `value` is a current SCIM User id. Group names are trimmed, case-insensitively unique within the organization, and filtered without regard to letter case. Member additions and replacements require current users; removing an unknown or deleted member id succeeds as a no-op. Multiple membership operations in one PATCH run in request order. `DELETE /Groups/{id}` returns 204, removes the resource from later reads, and removes assignments owned by that group's mapping. A later create with the same name or external id restores the stable group id with the members in that create request. A create matching a current group returns `409`.

Provider groups do not change Cuttlely authorization by themselves. An owner or a role with `authentication:manage` can map one group to one team and optionally choose a permitted role. Owner and authentication-settings roles cannot be selected. A pre-existing manual team membership remains manual and the mapping does not take it over. If two mapped groups request different roles for the same person and team, reconciliation removes any mapping-owned assignment for that pair, leaves independently changed membership alone, and records a diagnostic.

While a mapping exists, Cuttlely refuses a role edit that would make its role an Owner or give it `authentication:manage`, refuses deletion of that role, and refuses deletion of the mapped team. Remove the mapping through its preview and confirmation first. A person with a current SCIM link also cannot be removed directly from the organization; delete that person in the identity provider or remove the SCIM link first. These refusals return `409`, keep the referenced records unchanged, and appear in the audit log.

Creating a mapping first shows the assignments to add, unchanged manual memberships, the selected role, and any conflicts. Confirming the current preview requires a fresh sign-in. Removing a mapping similarly shows its exact mapping-owned assignments before confirmation. If either preview changes before confirmation, Cuttlely returns 409 without changing the mapping and requires a new preview. Deactivation removes the effect of mapping-owned assignments; reactivation reconciles current group membership. Deletion removes provider group memberships, so a recreated user receives no mapped team access until the provider adds those memberships again. Every authorization change advances that user's permission version in the same transaction. Group and mapping changes, and refused last-owner changes, appear in the audit log. Group audit details contain only the group id, operation, and member count.

The Operations section shows credential state, request times, operation counts, the latest failure category, and up to 20 recent sanitized errors with correlation ids. Counts and request times are calculated in the database for the 30-day window; only the bounded error list is returned. Correlation and request-limit handling run first, and SCIM authentication runs before JSON parsing. After authentication, malformed JSON sent with a supported content type and bodies over 256 KB receive SCIM errors and appear here. Diagnostics are retained for 30 days. Bearer values and provisioned profile attributes are not stored in diagnostics or displayed there.

Refused SCIM authentication attempts are recorded in the audit log in fixed five-minute windows per organization. The first attempt creates the row immediately, and each later attempt in that window updates its count, first and last occurrence times, and whether the credential was missing or refused. A later attempt starts a new window, so the audit count is stored after every request and does not depend on an in-memory timer.

SCIM v2 does not support bulk operations, sorting, or ETags. List pages are limited to 100 resources.

The staged confirmation is stored in the database with a version, ten-minute expiry, and single-use marker. It can be applied by another application process; an expired, consumed, or stale-version stage is refused. Staging and applying each allow 10 requests per client address in 15 minutes; more return 429 with `{ "type": "authentication_rate_limit" }`. These request limits are counted in each server process: with several replicas behind a load balancer, each replica keeps its own count, and a restart resets it. The durable stage record, not the request limit, is what keeps a switch single-use.

## Upgrade behavior

On the first start after upgrade, Cuttlely records a database installation id and infers the current method once:

-   A complete WorkOS configuration remains on WorkOS.
-   A complete WorkOS configuration with `CUTTLELY_LOCAL_USERS=true` also remains on WorkOS. The page reports the mixed settings for review, but automatic email linking and invitation sign-in continue normally.
-   Local-user mode remains on Local login.
-   An owner-only installation keeps recovery access without enabling ordinary local login.

On the first start with this release, Cuttlely writes one database cutoff marker. Everyone whose browser still has the older sealed WorkOS session signs in again once. The old cookie is cleared and is never exchanged into a Cuttlely session. Existing local-user sessions are unchanged, and API keys continue working. Repeated starts reuse the marker and do not repeat the cutoff.

Only a saved WorkOS client identity that differs from the current client identity pauses automatic email linking, including the email linking used to accept an invitation. Existing durable WorkOS subject links can still sign in. An administrator must complete a fresh sign-in and explicitly acknowledge that warning on **Auth / SSO**. The confirmation states that the action ends every interactive session, including the administrator's session, so everyone must sign in again. The audited action advances the authentication epoch, records the time and number of sessions ended, accepts the current configuration fingerprint, and enables automatic email and invitation linking again. Other configuration warnings are informational and do not pause linking. Compatibility sign-in, callback, refresh, resolve, logout, and settings routes remain available for this minor release line.

`TOKEN_HASH_SECRET` supplies derived material for authentication epoch binding. It also binds chat-session ownership, file-download links, setup codes, flow-check cursors and their searches, and email-based login lockout identifiers. Changing `TOKEN_HASH_SECRET` means existing values for each of those uses no longer match. Client-address lockout rows and database session token digests are independent of it. When `TOKEN_HASH_SECRET` is unset, Cuttlely uses its persisted instance fallback.

To rotate `TOKEN_HASH_SECRET`, set the same `TOKEN_HASH_SECRET` on the server and every worker, then restart them together. Outstanding WorkOS epoch bindings, chat ownership tokens, signed file-download URLs, setup codes, flow-check cursors and search tokens, and stored email lockout identifiers made with the previous value no longer validate. Current database sign-in sessions continue because their token digests do not use `TOKEN_HASH_SECRET`. To end every interactive session, change the selected method under **Admin** > **Auth / SSO**; to end sessions for one person, use **Admin** > **Users** > **Sessions**.

Method-change and client-identity acknowledgment audit rows include the configuration fingerprint, session count, and outcome. Refused and failed apply attempts are recorded without secret values.
