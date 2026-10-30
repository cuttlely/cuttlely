/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Fixed permission sets for the seeded roles. Keys come from the catalog.
 */

import { catalogKeys } from './permissionsCatalog'

/** Stable ids. owner, member, and personal workspace already use the first three. */
export const BUILT_IN_ROLE_ID = {
    owner: '00000000-0000-4000-8000-000000000001',
    member: '00000000-0000-4000-8000-000000000002',
    personalWorkspace: '00000000-0000-4000-8000-000000000003',
    admin: '00000000-0000-4000-8000-000000000004',
    builder: '00000000-0000-4000-8000-000000000005',
    viewer: '00000000-0000-4000-8000-000000000006'
} as const

const BUILD_ACTIONS = new Set([
    'view',
    'create',
    'update',
    'duplicate',
    'import',
    'export',
    'config',
    'domains',
    'add-loader',
    'delete-loader',
    'preview-process',
    'upsert-config',
    'run',
    'marketplace',
    'custom',
    'toolexport',
    'flowexport',
    'delete'
])

/** Builder does not administer people, roles, teams, server logs, or the audit log. */
const BUILD_EXCLUDED = new Set(['users', 'roles', 'workspace', 'logs', 'audit', 'authentication'])

export interface SeededBuiltInRole {
    id: string
    name: string
    description: string
}

export const SEEDED_BUILT_IN_ROLES: SeededBuiltInRole[] = [
    {
        id: BUILT_IN_ROLE_ID.admin,
        name: 'admin',
        description: 'Manages people, roles, and teams. Cannot assign Owner or remove the last owner.'
    },
    {
        id: BUILT_IN_ROLE_ID.builder,
        name: 'builder',
        description: 'Builds and edits flows, tools, and data. Does not manage people, roles, or teams.'
    },
    {
        id: BUILT_IN_ROLE_ID.viewer,
        name: 'viewer',
        description: 'Opens pages. Does not change them, and does not open server logs.'
    }
]

export function builtInRoleName(name: string): 'owner' | 'admin' | 'builder' | 'viewer' | null {
    const value = name.trim().toLowerCase()
    if (value === 'owner' || value === 'admin' || value === 'builder' || value === 'viewer') return value
    return null
}

export function isReservedRoleName(name: string): boolean {
    const value = name.trim().toLowerCase()
    return (
        value === 'owner' ||
        value === 'admin' ||
        value === 'builder' ||
        value === 'viewer' ||
        value === 'member' ||
        value === 'personal workspace'
    )
}

function sorted(keys: Iterable<string>): string[] {
    return [...keys].sort()
}

/** Null when the name is not Owner, Admin, Builder, or Viewer. */
export function builtInPermissionKeys(name: string): string[] | null {
    const kind = builtInRoleName(name)
    if (!kind) return null
    const catalog = catalogKeys()
    if (kind === 'owner' || kind === 'admin') return sorted(catalog)
    if (kind === 'viewer') {
        return sorted(catalog.filter((key) => key.endsWith(':view') && !key.startsWith('logs:') && !key.startsWith('audit:')))
    }
    return sorted(
        catalog.filter((key) => {
            const [prefix, action] = key.split(':')
            if (BUILD_EXCLUDED.has(prefix || '')) return false
            return BUILD_ACTIONS.has(action || '')
        })
    )
}

export function builtInPermissionJson(name: string): string | null {
    const keys = builtInPermissionKeys(name)
    return keys ? JSON.stringify(keys) : null
}

/** True when the new set drops a key, or the person loses the owner bypass. */
export function permissionsLowered(before: string[], after: string[], lostOwner: boolean): boolean {
    if (lostOwner) return true
    const next = new Set(after)
    return before.some((key) => !next.has(key))
}
