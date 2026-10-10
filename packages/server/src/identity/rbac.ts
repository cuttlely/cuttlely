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
 * Route gate from docs/identity/phase0-spec.md sections 5, 7.3, and 10.
 * Permission strings are the ones the routes already pass.
 */

import { Request, RequestHandler, Response } from 'express'
import { TeamAccess, teamAccess } from './sqlStore'

export interface TeamPermissionLookup {
    accessFor(userId: string, workspaceId: string): Promise<TeamAccess>
}

interface Actor {
    id?: unknown
    permissions?: unknown
    activeWorkspaceId?: unknown
}

let installed: TeamPermissionLookup | null = null

/** Tests install a lookup. Production uses one SQL statement. */
export function setTeamPermissionLookup(lookup: TeamPermissionLookup | null): void {
    installed = lookup
}

/** Every argument is one permission. A comma is a caller mistake and throws here, when the route is defined. */
export function requirePermission(...permissions: string[]): RequestHandler {
    for (const permission of permissions) {
        if (permission.includes(',')) {
            throw new Error('requirePermission accepts one permission per argument. Use requireAnyPermission for a comma-separated list.')
        }
    }
    return gate('all', permissions)
}

/** One listed permission is enough. A comma-separated string matches checkAnyPermission. */
export function requireAnyPermission(...permissions: string[]): RequestHandler {
    return gate('any', permissions)
}

/**
 * Server-wide settings, such as copying version history to GitHub: only the organization owner
 * (Super User). A role grant is not enough, and an API key never passes.
 */
export function requireOwner(): RequestHandler {
    return (req, res, next) => {
        void decideOwner(req)
            .then((status) => {
                if (status === 200) next()
                else send(res, status)
            })
            .catch(() => {
                if (!res.headersSent) send(res, 500)
            })
    }
}

async function decideOwner(req: Request): Promise<200 | 401 | 403> {
    const user = req.user as Actor | undefined
    if (!user) return 401
    const userId = typeof user.id === 'string' && user.id ? user.id : null
    if (!userId) return 403
    const workspaceId = typeof user.activeWorkspaceId === 'string' ? user.activeWorkspaceId : ''
    const access = await loadTeamAccess(userId, workspaceId)
    return access.owner ? 200 : 403
}

// The same decision as requireAnyPermission, for a check that depends on the loaded record
// (for example the type of the flow being changed).
export async function hasAnyPermission(req: Request, ...permissions: string[]): Promise<boolean> {
    return (await decide(req, permissions.flatMap(splitPermissions), 'any')) === 200
}

function gate(mode: 'all' | 'any', permissions: string[]): RequestHandler {
    const required = permissions.flatMap(splitPermissions)
    return (req, res, next) => {
        void decide(req, required, mode)
            .then((status) => {
                if (status === 200) next()
                else send(res, status)
            })
            .catch(() => {
                if (!res.headersSent) send(res, 500)
            })
    }
}

async function decide(req: Request, required: string[], mode: 'all' | 'any'): Promise<200 | 401 | 403> {
    const user = req.user as Actor | undefined
    if (!user) return 401
    if (!required.length) return 403
    const userId = typeof user.id === 'string' && user.id ? user.id : null
    if (userId) {
        const workspaceId = typeof user.activeWorkspaceId === 'string' ? user.activeWorkspaceId : ''
        const access = await loadTeamAccess(userId, workspaceId)
        if (access.owner) return 200
        if (!workspaceId || access.permissions === null || !holds(access.permissions, required, mode)) return 403
        return 200
    }
    return holds(listed(user.permissions), required, mode) ? 200 : 403
}

async function loadTeamAccess(userId: string, workspaceId: string): Promise<TeamAccess> {
    if (installed) return installed.accessFor(userId, workspaceId)
    const { getDataSource } = await import('../DataSource')
    return teamAccess(getDataSource(), userId, workspaceId)
}

function holds(grants: string[], required: string[], mode: 'all' | 'any'): boolean {
    if (mode === 'all') return required.every((permission) => grants.includes(permission))
    return required.some((permission) => grants.includes(permission))
}

function splitPermissions(value: string): string[] {
    return value
        .split(',')
        .map((permission) => permission.trim())
        .filter(Boolean)
}

function listed(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
    if (typeof value !== 'string' || !value) return []
    try {
        const parsed = JSON.parse(value) as unknown
        if (Array.isArray(parsed)) return listed(parsed)
    } catch {
        return splitPermissions(value)
    }
    return []
}

function send(res: Response, status: 401 | 403 | 500): void {
    const message = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Permission check failed'
    res.status(status).json({ message })
}
