/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * GET /api/v1/audit. Login activity stays closed.
 */

import { Request, RequestHandler, Response, Router } from 'express'
import { settingsDir } from '../settings/store'
import { AuditQueryError, AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, pageAudit } from './auditLog'
import { Sql } from './directory'
import { applicationSql } from './production'
import { requirePermission, resolveTeamAccess } from './rbac'

export const identityAuditRouter = Router()

let sqlOverride: Sql | null = null
let historyDirOverride: string | null = null

/** Tests point the list at a database that is not the process database. */
export function setAuditReaderForTests(sql: Sql | null, historyDir?: string | null): void {
    sqlOverride = sql
    historyDirOverride = historyDir === undefined ? null : historyDir
}

function readerSql(): Sql {
    if (sqlOverride) return sqlOverride
    return applicationSql()
}

/** audit:view, or the organization owner. An API key has no user id and never passes. */
function requireAuditViewer(): RequestHandler {
    const gate = requirePermission('audit:view')
    return (req, res, next) => {
        const user = req.user as { id?: unknown } | undefined
        if (user && typeof user.id !== 'string') {
            res.status(403).json({ message: 'Forbidden' })
            return
        }
        gate(req, res, next)
    }
}

function one(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    return ''
}

function limitOf(value: unknown): number {
    if (value === undefined || value === '') return AUDIT_PAGE_DEFAULT
    const text = one(value).trim()
    if (!/^\d+$/.test(text)) throw new AuditQueryError('INVALID_LIMIT', 'limit must be a whole number from 1 to 100')
    const limit = Number(text)
    if (limit < 1 || limit > AUDIT_PAGE_MAX) throw new AuditQueryError('INVALID_LIMIT', 'limit must be a whole number from 1 to 100')
    return limit
}

identityAuditRouter.get('/', requireAuditViewer(), (req: Request, res: Response) => {
    void (async () => {
        const user = req.user as { id?: unknown; activeOrganizationId?: unknown; activeWorkspaceId?: unknown }
        const userId = typeof user.id === 'string' ? user.id : ''
        const organizationId = typeof user.activeOrganizationId === 'string' ? user.activeOrganizationId : ''
        const workspaceId = typeof user.activeWorkspaceId === 'string' ? user.activeWorkspaceId : ''
        if (!userId || !organizationId) {
            res.status(401).json({ message: 'Unauthorized' })
            return
        }
        const access = await resolveTeamAccess(userId, workspaceId)
        if (!access.owner && !workspaceId) {
            res.status(403).json({ message: 'Forbidden' })
            return
        }
        try {
            const page = await pageAudit(
                readerSql(),
                { organizationId, workspaceId: workspaceId || null, owner: access.owner },
                {
                    type: one(req.query.type),
                    user: one(req.query.user),
                    cursor: one(req.query.cursor) || null,
                    limit: limitOf(req.query.limit),
                    historyDir: historyDirOverride || settingsDir()
                }
            )
            res.set('Cache-Control', 'no-store')
            res.status(200).json(page)
        } catch (error) {
            if (error instanceof AuditQueryError) {
                res.status(error.status).json({ message: error.message, code: error.code })
                return
            }
            res.status(500).json({ message: 'The audit log could not be read' })
        }
    })()
})

identityAuditRouter.use((_req, res) => {
    res.status(404).json({ message: 'Not Found' })
})
