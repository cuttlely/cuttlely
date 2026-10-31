<!-- Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. -->

# SCIM API

The SCIM v2 base path is `/api/v1/scim/v2`. Send the one-time credential created on **Admin** > **Auth / SSO** with bearer authentication. Session cookies and application API keys are not accepted on this path. Requests may use `application/scim+json` or `application/json`; responses use `application/scim+json`.

Every request receives a correlation id and passes the SCIM request limit before a JSON body is read. A request over that limit returns `429`; otherwise, a missing or inactive SCIM credential returns `401` before body parsing. Credential rotation may keep the previous value active for an administrator-selected overlap of 0 to 24 hours. Validation reads the database for every request, so overlap end and revocation apply across application processes. After authentication, malformed JSON sent with a supported content type returns `400 invalidSyntax`, and a body over 256 KB returns a SCIM `413` error. Both carry a correlation id and appear in Operations diagnostics.

## Discovery

-   `GET /ServiceProviderConfig` reports PATCH and filtering, a maximum list count of 100, no bulk, no password change, no sorting, and no ETags.
-   `GET /ResourceTypes`, `/ResourceTypes/User`, and `/ResourceTypes/Group` describe the resources.
-   `GET /Schemas` and the individual User and Group schema paths describe the supported core attributes.
-   `/Bulk` returns a standards-shaped `501` error. Sorting and ETags are not supported.

## Users

-   `POST /Users` creates or cautiously links a user. `userName` is an email address. `externalId`, `displayName`, `name.givenName`, `name.familyName`, a work email, and `active` are supported.
-   `GET /Users/{id}` reads the stable SCIM resource id. The internal user id and email are never used as that resource id.
-   `GET /Users` accepts `startIndex`, `count`, `attributes`, `excludedAttributes`, and a filter. The supported grammar is `eq` with `and`, `or`, and parentheses on `userName`, `externalId`, and `displayName`. Attribute names, `userName`, and `displayName` comparisons are case-insensitive. Results have stable order and `count` is at most 100.
-   `PUT /Users/{id}` replaces supported values. `active: false` deactivates the account.
-   `PATCH /Users/{id}` accepts case-insensitive Add, Replace, and Remove operations. Supported paths are `active`, `userName`, `externalId`, `displayName`, `name.givenName`, `name.familyName`, and `emails[type eq "work"].value`. A pathless replacement object is also accepted, and `active` accepts boolean or case-insensitive string values.
-   `DELETE /Users/{id}` returns `204`, deactivates the internal account, removes its group memberships, reconciles mapped assignments, and removes the resource from later GET, list, and filter results.

Creation never grants the owner role. An exact normalized email may link only one unlinked, non-owner account; otherwise Cuttlely creates an organization member with no password, session, or invitation email. If a deleted SCIM resource is created again with the same `userName`, Cuttlely restores its stable resource id and account. No previous session, API key, or personal token is restored.

All deactivation forms disable the user globally, close every open invite and reset link for that user across organizations, advance the authentication version, delete sessions, and disable owned API keys and personal tokens in one transaction. The last active owner cannot be deactivated, deleted, or demoted. The response is `409` and the transaction makes no account, role, session, or credential change.

SCIM deactivation also changes a linked pending account to disabled. Administrator disable preserves a pending account's `invited` status while closing its membership and invite links; saving it as invited reopens the membership without activating the account or restoring an old invite link.

## Groups

-   `POST /Groups` creates a provider group with required `displayName`, optional `externalId`, and an optional `members` array. `displayName` is trimmed and unique per organization without regard to letter case.
-   `GET /Groups/{id}` reads a stable group id. `GET /Groups` accepts `startIndex`, `count`, `attributes`, `excludedAttributes`, and `eq` filters joined by `and`, `or`, and parentheses on `displayName` and `externalId`. `displayName` comparison is case-insensitive.
-   `excludedAttributes=members` omits the member list.
-   `PUT /Groups/{id}` replaces the supported attributes and complete membership.
-   `PATCH /Groups/{id}` accepts case-insensitive Add, Replace, and Remove operations. Members may be added, removed, or replaced with value arrays. Remove also accepts `members[value eq "id"]`. Pathless replacement supports `displayName`, `externalId`, and `members`.
-   Member additions and full replacements require current SCIM User ids. An unknown or deleted id returns `400 invalidValue` and the request makes no partial change. Removing an unknown or already-deleted id succeeds as a no-op.
-   `DELETE /Groups/{id}` returns 204, removes the group from later reads, and transactionally removes assignments owned by its mapping.

Group storage and membership are provider-scoped and independent of Cuttlely roles until an administrator creates a mapping. A mapping connects one group to one team and optionally one allowed role. Roles with `authentication:manage` and the owner role are refused at creation and checked again during every reconcile. Reconciliation creates and changes only assignments in its ownership ledger. It does not take over a manual membership, change an owner, or touch unrelated teams. Conflicting role requests for one user and team remove mapping-owned membership for that pair, preserve independently changed membership, and create a diagnostic.

Mapping creation uses `POST /api/v1/authentication-settings/scim-mappings/preview` to return the selected group, team, role, assignments to add, manual memberships, conflicts, and a fingerprint. `POST /api/v1/authentication-settings/scim-mappings/confirm` recomputes that preview and requires its fingerprint before creating the mapping. Mapping removal uses `GET /api/v1/authentication-settings/scim-mappings/{id}/remove-preview` and `POST /api/v1/authentication-settings/scim-mappings/{id}/remove` in the same way. A changed fingerprint returns 409 without applying the change. These routes remain behind normal Admin authentication and `authentication:manage`; confirmation also requires a fresh sign-in.

Group membership changes, group deletion, mapping confirmation, and user deactivation, reactivation, or recreation reconcile in the triggering transaction and advance permission versions for affected users. User deletion removes provider group memberships, so recreation does not restore mapped access unless the provider adds those memberships again. Group audits contain only the group id, operation, and member count. Mapping changes and refused last-owner changes also use sanitized audit entries.

## Operations

The Auth / SSO page shows credential state, last successful and completed request times, the last failed category, operation counts, and recent sanitized errors. Each error response includes an `X-Correlation-ID` header and the same id in `detail`. Diagnostics contain no bearer value or provisioned profile attributes and are retained for 30 days.

The fixture suites follow published Okta and Entra ID request examples. They do not represent certification by either provider.

## Errors

Errors use schema `urn:ietf:params:scim:api:messages:2.0:Error`, a string `status`, a `detail`, a correlation id, and `scimType` where defined. Cuttlely uses `invalidFilter`, `invalidValue`, `invalidSyntax`, `uniqueness`, `mutability`, `noTarget`, and `tooMany`.
