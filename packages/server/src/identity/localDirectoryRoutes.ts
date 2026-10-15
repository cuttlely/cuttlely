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
 * Local-users routes for people, fixed roles, and sessions.
 * 404 unless local users mode is on (password sign-in, AuthKit unset).
 */

import { NextFunction, Request, Response, Router } from 'express'
import { getDataSource } from '../DataSource'
import { localUsersMode } from './constants'
import {
    DirectoryActor,
    DirectoryError,
    Page,
    createRole,
    deleteRole,
    endUserSession,
    endUserSessions,
    listLocalUsers,
    listRoles,
    listUserSessions,
    pageFrom,
    setUserDisabled,
    sqlFromDataSource,
    updateRole,
    updateWorkspaceUserRole
} from './directory'
import { requirePermission } from './rbac'

function one(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    return ''
}

function actorFrom(req: Request): DirectoryActor {
    const user = req.user as { id?: unknown; activeOrganizationId?: unknown; activeWorkspaceId?: unknown } | undefined
    const id = typeof user?.id === 'string' ? user.id : ''
    const organizationId = typeof user?.activeOrganizationId === 'string' ? user.activeOrganizationId : ''
    if (!id || !organizationId) throw new DirectoryError(401, 'Unauthorized')
    return {
        id,
        organizationId,
        workspaceId: typeof user?.activeWorkspaceId === 'string' ? user.activeWorkspaceId : null
    }
}

function send(run: (req: Request) => Promise<unknown>, status = 200) {
    return (req: Request, res: Response, next: NextFunction) => {
        void run(req)
            .then((body) => {
                if (!res.headersSent) res.status(status).json(body)
            })
            .catch((error: unknown) => {
                if (error instanceof DirectoryError) {
                    if (!res.headersSent) res.status(error.status).json({ message: error.message })
                    return
                }
                next(error)
            })
    }
}

function localOnly(_req: Request, res: Response, next: NextFunction) {
    if (!localUsersMode()) {
        res.status(404).json({ message: 'Not Found' })
        return
    }
    next()
}

function sql() {
    return sqlFromDataSource(getDataSource())
}

function disabledFlag(body: unknown): boolean {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    if (typeof record.disabled !== 'boolean') throw new DirectoryError(400, 'disabled must be true or false')
    return record.disabled
}

function rolePage(query: Request['query']): Page {
    return pageFrom({ limit: query.limit, offset: query.offset, q: query.q, sort: 'name' })
}

export const identityUsersRouter = Router()
identityUsersRouter.use(localOnly)
identityUsersRouter.get(
    '/',
    requirePermission('users:manage'),
    send((req) => listLocalUsers(sql(), actorFrom(req), pageFrom(req.query as Record<string, unknown>)))
)
identityUsersRouter.patch(
    '/:id',
    requirePermission('users:manage'),
    send((req) => setUserDisabled(sql(), actorFrom(req), one(req.params.id), disabledFlag(req.body)))
)
identityUsersRouter.post(
    '/:id/disable',
    requirePermission('users:manage'),
    send((req) => setUserDisabled(sql(), actorFrom(req), one(req.params.id), true))
)
identityUsersRouter.post(
    '/:id/enable',
    requirePermission('users:manage'),
    send((req) => setUserDisabled(sql(), actorFrom(req), one(req.params.id), false))
)
identityUsersRouter.put(
    '/:id/role',
    requirePermission('workspace:update'),
    send((req) => {
        const record = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
        return updateWorkspaceUserRole(sql(), actorFrom(req), {
            userId: one(req.params.id),
            workspaceId: one(record.workspaceId),
            roleId: one(record.roleId)
        })
    })
)
identityUsersRouter.get(
    '/:id/sessions',
    requirePermission('users:manage'),
    send((req) => listUserSessions(sql(), actorFrom(req), one(req.params.id), pageFrom(req.query as Record<string, unknown>)))
)
identityUsersRouter.delete(
    '/:id/sessions/:sessionId',
    requirePermission('users:manage'),
    send((req) => endUserSession(sql(), actorFrom(req), one(req.params.id), one(req.params.sessionId)))
)
identityUsersRouter.delete(
    '/:id/sessions',
    requirePermission('users:manage'),
    send((req) => endUserSessions(sql(), actorFrom(req), one(req.params.id)))
)

export const identityRolesRouter = Router()
identityRolesRouter.use(localOnly)
identityRolesRouter.get(
    '/',
    requirePermission('roles:manage'),
    send(async (req) => {
        const actor = actorFrom(req)
        const page = rolePage(req.query)
        const roles = await listRoles(sql(), actor, actor.organizationId)
        const q = page.q
        const filtered = roles
            .filter((role) => !q || role.name.toLowerCase().includes(q) || role.description.toLowerCase().includes(q))
            .sort((left, right) => left.name.localeCompare(right.name))
        return {
            roles: filtered.slice(page.offset, page.offset + page.limit).map((role) => ({
                id: role.id,
                name: role.name,
                description: role.description,
                permissions: JSON.parse(role.permissions) as string[],
                builtIn: role.readOnly === true,
                userCount: role.userCount
            })),
            limit: page.limit,
            offset: page.offset,
            total: filtered.length
        }
    })
)
identityRolesRouter.post(
    '/',
    requirePermission('roles:manage'),
    send((req) => createRole(sql(), actorFrom(req), req.body))
)
identityRolesRouter.patch(
    '/:id',
    requirePermission('roles:manage'),
    send((req) => updateRole(sql(), actorFrom(req), { ...(req.body as object), id: one(req.params.id) }))
)
identityRolesRouter.delete(
    '/:id',
    requirePermission('roles:manage'),
    send((req) => deleteRole(sql(), actorFrom(req), one(req.params.id), actorFrom(req).organizationId))
)
