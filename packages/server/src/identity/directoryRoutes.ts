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
import { requireAnyPermission, requirePermission } from './rbac'
import {
    DirectoryActor,
    DirectoryError,
    createRole,
    createWorkspace,
    deleteOrganizationUser,
    deleteRole,
    deleteWorkspace,
    deleteWorkspaceUser,
    getWorkspace,
    listOrganizationUsers,
    listRoles,
    listWorkspaceMemberships,
    listWorkspaces,
    sqlFromDataSource,
    switchWorkspace,
    updateOrganizationUser,
    updateRole,
    updateWorkspace,
    updateWorkspaceUserRole
} from './directory'
import { identityStore } from './production'
import { teamAccess } from './sqlStore'
import { acceptLocalPassword, inviteAccount, resetLocalLink } from './actionLink'
import { HandlerResult } from './types'

function one(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    return ''
}

async function actorWithAccess(req: Request): Promise<DirectoryActor> {
    const actor = actorFrom(req)
    const access = await teamAccess(getDataSource(), actor.id, actor.workspaceId || '')
    return { ...actor, owner: access.owner, permissions: access.permissions || [] }
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
        void run(req)
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

export const identityUsersRouter = Router()
identityUsersRouter.post(
    '/:id/reset-link',
    requirePermission('users:manage'),
    send(async (req) => resetLocalLink(sql(), await actorWithAccess(req), one(req.params.id), req.body))
)
identityUsersRouter.use(notFound)

/** Unauthenticated. The token is read from the JSON body. A query value is ignored. */
export function acceptLocalRoute(
    ctx: { body: Record<string, unknown>; ip: string; now: number },
    query: Record<string, unknown>
): Promise<HandlerResult> {
    return acceptLocalPassword(sql(), { body: ctx.body, query, ip: ctx.ip, now: ctx.now })
}

export function registerInvite(router: Router): void {
    router.post(
        '/invite',
        manageUsers,
        send(async (req) => inviteAccount(sql(), await actorWithAccess(req), req.body))
    )
}
