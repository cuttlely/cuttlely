/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * The filter matches CreateEditRoleDialog and APIKeyDialog.
 */
import express, { Request } from 'express'
import request from 'supertest'
import { identityAuthRouter } from './http'
import { permissionsAfterPlatformFilter, rolePermissionCatalog } from './permissionsCatalog'
import { setTeamPermissionLookup } from './rbac'

function app() {
    const server = express()
    server.use((req, _res, next) => {
        const user: object = {
            id: 'user-1',
            activeWorkspaceId: 'team-a',
            permissions: [],
            isOrganizationAdmin: false
        }
        ;(req as Request).user = user as Express.User
        next()
    })
    server.use('/api/v1/auth', identityAuthRouter)
    return server
}

describe('permission catalogs', () => {
    afterEach(() => setTeamPermissionLookup(null))

    it('keeps role checkboxes on open source after the dialog filter', () => {
        const visible = permissionsAfterPlatformFilter(rolePermissionCatalog(), 'open-source')
        const rows = Object.values(visible).flat()
        expect(rows.length).toBeGreaterThan(0)
        expect(visible.chatflows?.map((row) => row.key)).toContain('chatflows:view')
        expect(visible.workspace?.map((row) => row.key)).toContain('workspace:view')
        expect(visible.datasets?.map((row) => row.key)).toContain('datasets:view')
        expect(visible.evaluators?.map((row) => row.key)).toContain('evaluators:create')
        expect(visible.evaluations?.map((row) => row.key)).toContain('evaluations:run')
        expect(rows.every((row) => row.isOpenSource === true)).toBe(true)
    })

    it('GET /auth/permissions/API_KEY returns a non-empty open-source list', async () => {
        setTeamPermissionLookup({
            accessFor: async () => ({ owner: true, permissions: null })
        })
        const response = await request(app()).get('/api/v1/auth/permissions/API_KEY')
        expect(response.status).toBe(200)
        const visible = permissionsAfterPlatformFilter(response.body, 'open-source')
        const rows = Object.values(visible).flat()
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.map((row) => row.key)).toContain('chatflows:view')
        expect(rows.map((row) => row.key).some((key) => key.startsWith('workspace:'))).toBe(false)
        expect(rows.map((row) => row.key)).not.toContain('users:manage')
        expect(rows.map((row) => row.key)).not.toContain('roles:manage')
        expect(rows.map((row) => row.key)).not.toContain('logs:view')
    })

    it('GET /auth/permissions/ROLE returns the same open-source list the dialog keeps', async () => {
        setTeamPermissionLookup({
            accessFor: async () => ({ owner: true, permissions: null })
        })
        const response = await request(app()).get('/api/v1/auth/permissions/ROLE')
        expect(response.status).toBe(200)
        const visible = permissionsAfterPlatformFilter(response.body, 'open-source')
        expect(Object.values(visible).flat().length).toBeGreaterThan(0)
        expect(visible.logs?.map((row) => row.key)).toContain('logs:view')
    })
})
