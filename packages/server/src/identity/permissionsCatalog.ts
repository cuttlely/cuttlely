/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Checkbox keys are the personal-workspace permission list stored
 * by the identity schema, plus the users, roles, and team keys the UI
 * already sends. Share, export, import, and SSO are left out.
 * Datasets, evaluators, and evaluations stay, matching the routes (D55).
 */

import { PERSONAL_WORKSPACE_PERMISSIONS } from '../database/identitySchema'

const DROPPED_PREFIXES = ['sso', 'loginActivity']
const DROPPED_KEYS = new Set(['credentials:share', 'templates:custom-share', 'workspace:export', 'workspace:import'])

/** Category name is the permission prefix. The role dialog compares it to `chatflows` and `workspace`. */
const ALLOWED_PREFIXES = new Set([
    'chatflows',
    'agentflows',
    'tools',
    'assistants',
    'credentials',
    'variables',
    'apikeys',
    'documentStores',
    'templates',
    'executions',
    'datasets',
    'evaluators',
    'evaluations',
    'users',
    'roles',
    'workspace'
])

/** The API-key service rejects workspace and admin grants. Users and roles are the same class of grant. */
const API_KEY_EXCLUDED_PREFIXES = new Set(['workspace', 'users', 'roles', 'admin'])

const ADMIN_KEYS = [
    'users:manage',
    'roles:manage',
    'workspace:view',
    'workspace:create',
    'workspace:update',
    'workspace:delete',
    'workspace:add-user',
    'workspace:unlink-user'
]

export interface PermissionChoice {
    key: string
    value: string
    /** The role and API-key dialogs hide a row when the flag for the current platform is not true. */
    isOpenSource: boolean
    isEnterprise: boolean
    isCloud: boolean
}

export type PermissionPlatform = 'open-source' | 'enterprise' | 'cloud'

function labelFor(key: string): string {
    const action = key.split(':')[1] || key
    const words = action.replace(/-/g, ' ')
    return words.charAt(0).toUpperCase() + words.slice(1)
}

function kept(key: string): boolean {
    const prefix = key.split(':')[0] || ''
    if (DROPPED_KEYS.has(key) || DROPPED_PREFIXES.includes(prefix)) return false
    return ALLOWED_PREFIXES.has(prefix)
}

function choice(key: string): PermissionChoice {
    return {
        key,
        value: labelFor(key),
        isOpenSource: true,
        isEnterprise: true,
        isCloud: true
    }
}

function group(keys: string[]): Record<string, PermissionChoice[]> {
    const catalog: Record<string, PermissionChoice[]> = {}
    for (const key of keys) {
        const category = key.split(':')[0]
        if (!catalog[category]) catalog[category] = []
        catalog[category].push(choice(key))
    }
    return catalog
}

/**
 * Same filter as CreateEditRoleDialog and APIKeyDialog.
 * A missing platform flag is false, so the row is hidden.
 */
export function permissionsAfterPlatformFilter(
    catalog: Record<string, PermissionChoice[]>,
    platform: PermissionPlatform
): Record<string, PermissionChoice[]> {
    const visible: Record<string, PermissionChoice[]> = {}
    for (const [category, rows] of Object.entries(catalog)) {
        const keptRows = rows.filter((permission) => {
            if (platform === 'open-source') return permission.isOpenSource === true
            if (platform === 'enterprise') return permission.isEnterprise === true
            return permission.isCloud === true
        })
        if (keptRows.length) visible[category] = keptRows
    }
    return visible
}

export function catalogKeys(): string[] {
    const stored = JSON.parse(PERSONAL_WORKSPACE_PERMISSIONS) as unknown
    const fromStore = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
    const keys = [...fromStore, ...ADMIN_KEYS].filter(kept)
    return [...new Set(keys)]
}

/** Shape the role dialog reads. Category keys are the permission prefixes. */
export function rolePermissionCatalog(): Record<string, PermissionChoice[]> {
    return group(catalogKeys())
}

/** Prediction keys. Workspace, user, and role grants are not offered. */
export function apiKeyPermissionCatalog(): Record<string, PermissionChoice[]> {
    return group(catalogKeys().filter((key) => !API_KEY_EXCLUDED_PREFIXES.has(key.split(':')[0] || '')))
}

export function isCatalogPermission(key: string): boolean {
    return catalogKeys().includes(key)
}
