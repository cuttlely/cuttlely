<!-- Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. -->

# SCIM API

The SCIM v2 base path is `/api/v1/scim/v2`. Send the credential created on **Admin** > **Auth / SSO** as `Authorization: Bearer VALUE`. Session cookies and application API keys are not accepted on this path. Requests may use `application/scim+json` or `application/json`; responses use `application/scim+json`.

When no SCIM credential exists, or when the supplied credential is not active, every route returns a SCIM `401` error. Credential rotation may keep the previous value active for an administrator-selected overlap of 0 to 24 hours. Validation reads the database for every request, so overlap end and revocation apply across application processes.

## Discovery

-   `GET /ServiceProviderConfig` reports PATCH and filtering, a maximum list count of 100, no bulk, no password change, no sorting, and no ETags.
-   `GET /ResourceTypes` and `GET /ResourceTypes/User` describe the User resource.
-   `GET /Schemas` and `GET /Schemas/urn:ietf:params:scim:schemas:core:2.0:User` describe the supported core attributes.
-   `/Bulk` returns a standards-shaped `501` error. Groups are not available yet.

## Users

-   `POST /Users` creates or cautiously links a user. `userName` is an email address. `externalId`, `displayName`, `name.givenName`, `name.familyName`, a work email, and `active` are supported.
-   `GET /Users/{id}` reads the stable SCIM resource id. The internal user id and email are never used as that resource id.
-   `GET /Users` accepts `startIndex`, `count`, `attributes`, `excludedAttributes`, and a filter. The supported grammar is `eq` with `and`, `or`, and parentheses on `userName`, `externalId`, and `displayName`. Attribute names and `userName` comparison are case-insensitive. Results have stable order and `count` is at most 100.
-   `PUT /Users/{id}` replaces supported values. `active: false` deactivates the account.
-   `PATCH /Users/{id}` accepts case-insensitive Add, Replace, and Remove operations. Supported paths are `active`, `userName`, `externalId`, `displayName`, `name.givenName`, `name.familyName`, and `emails[type eq "work"].value`. A pathless replacement object is also accepted, and `active` accepts boolean or case-insensitive string values.
-   `DELETE /Users/{id}` returns `204`, deactivates the internal account, and removes the resource from later GET, list, and filter results.

Creation never grants the owner role. An exact normalized email may link only one unlinked, non-owner account; otherwise Cuttlely creates an organization member with no password, session, or invitation email. If a deleted SCIM resource is created again with the same `userName`, Cuttlely restores its stable resource id and account. No previous session, API key, or personal token is restored.

All deactivation forms disable the user, close open invite and reset links, advance the authentication version, delete sessions, and disable owned API keys and personal tokens in one transaction. The last active owner cannot be deactivated, deleted, or demoted. The response is `409` and the transaction makes no account, role, session, or credential change.

SCIM deactivation also changes a linked pending account to disabled. Administrator disable preserves a pending account's `invited` status while closing its membership and invite links; saving it as invited reopens the membership without activating the account or restoring an old invite link.

## Errors

Errors use schema `urn:ietf:params:scim:api:messages:2.0:Error`, a string `status`, a `detail`, and `scimType` where defined. Cuttlely uses `invalidFilter`, `invalidValue`, `invalidSyntax`, `uniqueness`, `mutability`, `noTarget`, and `tooMany`.
