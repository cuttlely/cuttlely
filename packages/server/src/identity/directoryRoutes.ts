/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Route wrappers for the users, roles, and teams screens.
 */

import { NextFunction, Request, Response, Router } from 'express'
import { getDataSource } from '../DataSource'
import { localUsersMode } from './constants'
import { requireAnyPermission, requirePermission } from './rbac'
import {
    DirectoryActor,
    DirectoryError,
    Page,
    createEmailUser,
    createRole,
    createWorkspace,
    deleteOrganizationUser,
    deleteRole,
    deleteWorkspace,
    deleteWorkspaceUser,
    endUserSession,
    endUserSessions,
    getWorkspace,
    listLocalUsers,
    listOrganizationUsers,
    listRoles,
    listUserSessions,
    listWorkspaceMemberships,
    listWorkspaces,
    pageFrom,
    setUserDisabled,
    sqlFromDataSource,
    switchWorkspace,
    updateOrganizationUser,
    updateRole,
    updateWorkspace,
    updateWorkspaceUserRole
} from './directory'
import { identityStore } from './production'
import { teamAccess } from './sqlStore'

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

function send(run: (req: Request) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => {
        // pageFrom and disabledFlag throw before they return a promise. Start the chain
        // so that rejection uses error.status instead of the process error handler.
        void Promise.resolve()
            .then(() => run(req))
            .then((body) => {
                if (!res.headersSent) res.status(200).json(body)
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

function sql() {
    return sqlFromDataSource(getDataSource())
}

function notFound(_req: Request, res: Response) {
    res.status(404).json({ message: 'Not Found' })
}

const manageUsers = requireAnyPermission('users:manage,workspace:add-user')
const viewTeams = requirePermission('workspace:view')

async function holds(actor: DirectoryActor, permission: string): Promise<void> {
    const access = await teamAccess(getDataSource(), actor.id, actor.workspaceId || '')
    if (access.owner) return
    if (!access.permissions?.includes(permission)) throw new DirectoryError(403, 'Forbidden')
}

export const identityUserRouter = Router()
identityUserRouter.use(notFound)

export const identityOrgUserRouter = Router()
identityOrgUserRouter.get(
    '/',
    requirePermission('users:manage'),
    send((req) => listOrganizationUsers(sql(), actorFrom(req), one(req.query.organizationId)))
)
identityOrgUserRouter.put(
    '/',
    requirePermission('users:manage'),
    send((req) => updateOrganizationUser(sql(), actorFrom(req), req.body))
)
identityOrgUserRouter.delete(
    '/',
    requireAnyPermission('users:manage,workspace:unlink-user'),
    send((req) => deleteOrganizationUser(sql(), actorFrom(req), one(req.query.organizationId), one(req.query.userId)))
)
identityOrgUserRouter.use(notFound)

export const identityWorkspaceUserRouter = Router()
identityWorkspaceUserRouter.get(
    '/',
    send(async (req) => {
        const actor = actorFrom(req)
        const filter = {
            workspaceId: one(req.query.workspaceId),
            roleId: one(req.query.roleId),
            userId: one(req.query.userId),
            organizationId: one(req.query.organizationId)
        }
        const ownTeams = filter.userId === actor.id && !filter.workspaceId && !filter.roleId
        if (!ownTeams) {
            const permission = filter.workspaceId ? 'workspace:view' : filter.roleId ? 'roles:manage' : 'users:manage'
            await holds(actor, permission)
        }
        return listWorkspaceMemberships(sql(), actor, filter)
    })
)
identityWorkspaceUserRouter.put(
    '/',
    requirePermission('workspace:update'),
    send((req) => updateWorkspaceUserRole(sql(), actorFrom(req), req.body))
)
identityWorkspaceUserRouter.delete(
    '/',
    requireAnyPermission('workspace:unlink-user,users:manage'),
    send((req) => deleteWorkspaceUser(sql(), actorFrom(req), one(req.query.workspaceId), one(req.query.userId)))
)
identityWorkspaceUserRouter.use(notFound)

export const identityWorkspaceRouter = Router()
identityWorkspaceRouter.get(
    '/',
    viewTeams,
    send(async (req) => {
        const actor = actorFrom(req)
        const id = one(req.query.id)
        if (id) return getWorkspace(sql(), actor, id)
        return listWorkspaces(sql(), actor, one(req.query.organizationId))
    })
)
identityWorkspaceRouter.post(
    '/switch',
    send((req) => switchWorkspace(sql(), identityStore(), actorFrom(req), one(req.query.id)))
)
identityWorkspaceRouter.post(
    '/',
    requirePermission('workspace:create'),
    send((req) => createWorkspace(sql(), actorFrom(req), req.body))
)
identityWorkspaceRouter.put(
    '/',
    requirePermission('workspace:update'),
    send((req) => updateWorkspace(sql(), actorFrom(req), req.body))
)
identityWorkspaceRouter.delete(
    '/:id',
    requirePermission('workspace:delete'),
    send((req) => deleteWorkspace(sql(), actorFrom(req), one(req.params.id)))
)
identityWorkspaceRouter.use(notFound)

export const identityRoleRouter = Router()
identityRoleRouter.get(
    '/',
    requirePermission('roles:manage'),
    send((req) => listRoles(sql(), actorFrom(req), one(req.query.organizationId)))
)
identityRoleRouter.post(
    '/',
    requirePermission('roles:manage'),
    send((req) => createRole(sql(), actorFrom(req), req.body))
)
identityRoleRouter.put(
    '/',
    requirePermission('roles:manage'),
    send((req) => updateRole(sql(), actorFrom(req), req.body))
)
identityRoleRouter.delete(
    '/',
    requirePermission('roles:manage'),
    send((req) => deleteRole(sql(), actorFrom(req), one(req.query.id), one(req.query.organizationId)))
)
identityRoleRouter.use(notFound)

function localOnly(_req: Request, res: Response, next: NextFunction) {
    if (!localUsersMode()) {
        res.status(404).json({ message: 'Not Found' })
        return
    }
    next()
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

export function registerInvite(router: Router): void {
    router.post(
        '/invite',
        manageUsers,
        send((req) => createEmailUser(sql(), actorFrom(req), req.body))
    )
}
