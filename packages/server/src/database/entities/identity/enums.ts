/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Stored status strings. The closed team spelling `disable` is kept
 * as a write value.
 */

/** Stored in user.status. The column default is unverified. */
export enum UserStatus {
    UNVERIFIED = 'unverified',
    ACTIVE = 'active',
    INVITED = 'invited',
    DELETED = 'deleted'
}

/** Stored in organization_user.status. The column default is active. */
export enum OrganizationUserStatus {
    ACTIVE = 'active',
    INVITED = 'invited',
    DISABLED = 'disable'
}

/** Stored in workspace_user.status. The column default is invited. */
export enum WorkspaceUserStatus {
    ACTIVE = 'active',
    INVITED = 'invited',
    DISABLED = 'disable'
}

/** Stored in login_method.status. The column default is enable. */
export enum LoginMethodStatus {
    ENABLE = 'enable',
    DISABLE = 'disable'
}

/** role.name values the administration screens already pass around. */
export enum GeneralRole {
    OWNER = 'owner',
    MEMBER = 'member',
    PERSONAL_WORKSPACE = 'personal workspace'
}

/** organization.name default on a migrated database. */
export enum OrganizationName {
    DEFAULT_ORGANIZATION = 'Default Organization'
}

/** workspace.name values the identity module already uses. */
export enum WorkspaceName {
    DEFAULT_WORKSPACE = 'Default Workspace',
    DEFAULT_PERSONAL_WORKSPACE = 'Personal Workspace'
}
