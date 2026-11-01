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
-   `GET /Users` accepts `startIndex`, `count`, `attributes`, `excludedAttributes`, and a filter. The supported grammar is `eq` with `and`, `or`, and parentheses on `userName`, `externalId`, and `displayName`. Attribute names, `userName`, and `displayName` comparisons are case-insensitive; `externalId` comparisons are case-sensitive on every supported database. Results have stable order and `count` is at most 100.
-   `PUT /Users/{id}` replaces supported values. `active: false` deactivates the account.
-   `PATCH /Users/{id}` accepts case-insensitive Add, Replace, and Remove operations. Supported paths are `active`, `userName`, `externalId`, `displayName`, `name.givenName`, `name.familyName`, and `emails[type eq "work"].value`. Pathless Add and Replace merge only the attributes present in `value`; omitted attributes remain unchanged. Case-insensitive path keys in `value`, including `name.givenName`, `emails[type eq "work"].value`, and `active`, are accepted for Entra ID. `active` accepts boolean or case-insensitive string values.
-   `DELETE /Users/{id}` returns `204`, deactivates the internal account, removes its group memberships, reconciles mapped assignments, and removes the resource from later GET, list, and filter results.

Creation never grants the owner role. SCIM can provision a new account or link one unlinked, non-owner account that is already a member of the target organization and has no membership in any other organization. Like an ordinary invitation, it does not move or duplicate a global account that belongs to another organization: `POST /Users` returns `409 uniqueness` with no details about that account. SCIM also refuses updates, reactivation, deletion, and recreation for an account that has gained another organization membership. If a deleted SCIM resource is created again with the same `userName` while its sole organization membership remains the target organization, Cuttlely restores its stable resource id and account. No previous session, API key, or personal token is restored.

All deactivation forms disable the user globally, close every open invite and reset link for that user across organizations, advance the authentication version, delete sessions, and disable owned API keys and personal tokens in one transaction. Before that global disable, Cuttlely locks and checks every organization membership. Deactivation never leaves any organization without an active owner. The response is `409` and the transaction makes no account, role, session, or credential change.

SCIM deactivation also changes a linked pending account to disabled. Administrator disable preserves a pending account's `invited` status while closing its membership and invite links; saving it as invited reopens the membership without activating the account or restoring an old invite link.

## Groups

-   `POST /Groups` creates a provider group with required `displayName`, optional `externalId`, and an optional `members` array. `displayName` is trimmed and unique per organization without regard to letter case. If the name or external id matches a deleted group, the request restores that stable group id and replaces its members with the requested set. A match with a current group returns `409 uniqueness`.
-   `GET /Groups/{id}` reads a stable group id. `GET /Groups` accepts `startIndex`, `count`, `attributes`, `excludedAttributes`, and `eq` filters joined by `and`, `or`, and parentheses on `displayName` and `externalId`. `displayName` comparison is case-insensitive and `externalId` comparison is case-sensitive on every supported database.
-   `excludedAttributes=members` omits the member list.
-   `PUT /Groups/{id}` replaces the supported attributes and complete membership.
-   `PATCH /Groups/{id}` accepts case-insensitive Add, Replace, and Remove operations. Members may be added, removed, or replaced with value arrays. Remove also accepts `members[value eq "id"]`. Pathless Add and Replace merge only `displayName`, `externalId`, or `members` attributes present in `value`; omitted attributes remain unchanged. When one request contains several membership operations, they are applied sequentially in request order before one reconciliation.
-   Member additions and full replacements require current SCIM User ids. An unknown or deleted id returns `400 invalidValue` and the request makes no partial change. Removing an unknown or already-deleted id succeeds as a no-op.
-   `DELETE /Groups/{id}` returns 204, removes the group from later reads, and transactionally removes assignments owned by its mapping.

Group storage and membership are provider-scoped and independent of Cuttlely roles until an administrator creates a mapping. A mapping connects one group to one team and optionally one allowed role. Roles with `authentication:manage` and the owner role are refused at creation and checked again during every reconcile. Reconciliation creates and changes only assignments in its ownership ledger. It does not take over a manual membership, change an owner, or touch unrelated teams. Conflicting role requests for one user and team remove mapping-owned membership for that pair, preserve independently changed membership, and create a diagnostic.

Ordinary administration cannot change a mapped role into an Owner or add `authentication:manage`, delete a mapped role, or delete a mapped team. Each returns `409`; remove the mapping with its preview and confirmed removal first. Direct organization removal of a person with a current SCIM link also returns `409`. Delete the person in the identity provider or remove the SCIM link before using ordinary user removal. A SCIM-deleted link no longer blocks ordinary removal. That removal discards the deleted SCIM resource, its provider-group memberships, and its mapping-owned assignments. A later `POST /Users` provisions a new resource id only when the identity is new or is already a member of this organization; an account that still belongs to another organization returns `409 uniqueness`. Reprovisioning does not restore previous group memberships or mapped team access.

Mapping creation uses `POST /api/v1/authentication-settings/scim-mappings/preview` to return the selected group, team, role, assignments to add, manual memberships, conflicts, and a fingerprint. `POST /api/v1/authentication-settings/scim-mappings/confirm` recomputes that preview and requires its fingerprint before creating the mapping. Mapping removal uses `GET /api/v1/authentication-settings/scim-mappings/{id}/remove-preview` and `POST /api/v1/authentication-settings/scim-mappings/{id}/remove` in the same way. A changed fingerprint returns 409 without applying the change. These routes remain behind normal Admin authentication and `authentication:manage`; confirmation also requires a fresh sign-in.

Group membership changes, group deletion, mapping confirmation, and user deactivation, reactivation, or recreation reconcile in the triggering transaction and advance permission versions for affected users. User deletion removes provider group memberships, so recreation does not restore mapped access unless the provider adds those memberships again. Group audits contain only the group id, operation, and member count. Mapping changes and refused last-owner changes also use sanitized audit entries.

## Operations

The Auth / SSO page shows credential state, last successful, failed, and completed request times, the last failed category, operation counts, and up to 20 recent sanitized errors. Counts and timestamps use database aggregates scoped to the organization and 30-day window; the error list is a separate bounded query. Each error response includes an `X-Correlation-ID` header and the same id in `detail`. Diagnostics contain no bearer value or provisioned profile attributes. Diagnostics older than 30 days are excluded from Operations and are deleted the next time a SCIM request is recorded or Operations is opened.

Refused authentication attempts are stored as audit windows per organization. The first attempt writes a row immediately. Further attempts during the fixed five-minute window update that row with the complete count, first and last occurrence times, and missing/refused categories after every request. An attempt after the window starts a new row.

The fixture suites follow published Okta and Entra ID request examples. They do not represent certification by either provider.

## Errors

Errors use schema `urn:ietf:params:scim:api:messages:2.0:Error`, a string `status`, a `detail`, a correlation id, and `scimType` where defined. Cuttlely uses `invalidFilter`, `invalidValue`, `invalidSyntax`, `uniqueness`, `mutability`, `noTarget`, and `tooMany`.

Each supported query parameter may appear only once. Repeated parameters, including `filter`, `attributes`, `excludedAttributes`, `startIndex`, and `count`, return `400 invalidValue` in the SCIM error shape.
