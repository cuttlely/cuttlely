/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Route tests for the permission gate. Controllers are stubbed.
 */
import express, { Request, Router } from 'express'
import request from 'supertest'
import { builtInPermissionKeys } from './builtInRoles'
import { setTeamPermissionLookup } from './rbac'
import { TeamAccess } from './sqlStore'

const hits = { n: 0 }

jest.mock('../controllers/harnesses', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/etl', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/chatflows', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/credentials', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/apikey', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/flow-versions', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/flow-promote', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/model-prices', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/stats', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../controllers/flow-drafts', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                hits.n += 1
                res.status(200).json({ ok: true })
            }
        }
    )
}))

import modelPricesRouter from '../routes/model-prices'
import statsRouter from '../routes/stats'
import apikeyRouter from '../routes/apikey'
import chatflowsRouter from '../routes/chatflows'
import credentialsRouter from '../routes/credentials'
import etlRouter from '../routes/etl'
import harnessesRouter from '../routes/harnesses'
import flowVersionsRouter from '../routes/flow-versions'
import flowDraftsRouter from '../routes/flow-drafts'
import { setHarnessFlowLookup, setHarnessKeyLookup } from '../services/harnesses/apiAccess'

type Method = 'get' | 'post' | 'put' | 'delete'

interface Probe {
    method: Method
    path: string
    permission: string
}

interface Group {
    name: string
    router: Router
    allow: Probe
    anyOf: Probe
}

const groups: Group[] = [
    {
        name: 'harnesses',
        router: harnessesRouter,
        allow: { method: 'get', path: '/', permission: 'chatflows:view' },
        anyOf: { method: 'post', path: '/', permission: 'agentflows:create' }
    },
    {
        name: 'flow-versions',
        router: flowVersionsRouter,
        allow: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'chatflows:view' },
        anyOf: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666/abcdef1', permission: 'agentflows:view' }
    },
    {
        name: 'flow-versions restore',
        router: flowVersionsRouter,
        allow: { method: 'post', path: '/0b5c3a1e-1111-2222-3333-444455556666/abcdef1/restore', permission: 'chatflows:update' },
        anyOf: { method: 'post', path: '/0b5c3a1e-1111-2222-3333-444455556666/abcdef1/restore', permission: 'agentflows:update' }
    },
    {
        name: 'flow-drafts read',
        router: flowDraftsRouter,
        allow: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'chatflows:view' },
        anyOf: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'agentflows:view' }
    },
    {
        name: 'flow-drafts save',
        router: flowDraftsRouter,
        allow: { method: 'put', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'chatflows:update' },
        anyOf: { method: 'put', path: '/0b5c3a1e-1111-2222-3333-444455556666/settings', permission: 'agentflows:update' }
    },
    {
        name: 'flow-drafts discard',
        router: flowDraftsRouter,
        allow: { method: 'delete', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'chatflows:update' },
        anyOf: { method: 'delete', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'agentflows:update' }
    },
    {
        name: 'flow-drafts publish',
        router: flowDraftsRouter,
        allow: { method: 'post', path: '/0b5c3a1e-1111-2222-3333-444455556666/publish', permission: 'chatflows:update' },
        anyOf: { method: 'post', path: '/0b5c3a1e-1111-2222-3333-444455556666/publish', permission: 'agentflows:update' }
    },
    {
        name: 'flow-drafts rollback',
        router: flowDraftsRouter,
        allow: { method: 'post', path: '/0b5c3a1e-1111-2222-3333-444455556666/rollback', permission: 'chatflows:update' },
        anyOf: { method: 'post', path: '/0b5c3a1e-1111-2222-3333-444455556666/rollback', permission: 'agentflows:update' }
    },
    {
        name: 'flow-drafts check setup',
        router: flowDraftsRouter,
        allow: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666/check', permission: 'chatflows:view' },
        anyOf: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666/check/c1', permission: 'agentflows:view' }
    },
    {
        name: 'flow-drafts check history',
        router: flowDraftsRouter,
        allow: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666/check/history', permission: 'chatflows:view' },
        anyOf: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666/check/history', permission: 'agentflows:view' }
    },
    {
        name: 'flow-drafts check run',
        router: flowDraftsRouter,
        allow: { method: 'post', path: '/0b5c3a1e-1111-2222-3333-444455556666/check', permission: 'chatflows:update' },
        anyOf: { method: 'delete', path: '/0b5c3a1e-1111-2222-3333-444455556666/check/c1', permission: 'agentflows:update' }
    },
    {
        name: 'etl',
        router: etlRouter,
        allow: { method: 'get', path: '/pipelines', permission: 'chatflows:view' },
        anyOf: { method: 'post', path: '/pipelines/pipe-1/runs', permission: 'chatflows:update' }
    },
    {
        name: 'stats usage',
        router: statsRouter,
        allow: { method: 'get', path: '/usage', permission: 'chatflows:view' },
        anyOf: { method: 'get', path: '/usage', permission: 'agentflows:view' }
    },
    {
        name: 'stats chatflow',
        router: statsRouter,
        allow: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'chatflows:view' },
        anyOf: { method: 'get', path: '/0b5c3a1e-1111-2222-3333-444455556666', permission: 'agentflows:view' }
    },
    {
        name: 'chatflows',
        router: chatflowsRouter,
        allow: { method: 'get', path: '/', permission: 'chatflows:view' },
        anyOf: { method: 'delete', path: '/flow-1', permission: 'assistants:delete' }
    },
    {
        name: 'credentials',
        router: credentialsRouter,
        allow: { method: 'get', path: '/', permission: 'credentials:view' },
        anyOf: { method: 'get', path: '/cred-1', permission: 'credentials:update' }
    },
    {
        name: 'apikey',
        router: apikeyRouter,
        allow: { method: 'get', path: '/', permission: 'apikeys:view' },
        anyOf: { method: 'put', path: '/key-1', permission: 'apikeys:update' }
    }
]

const memberships = new Map<string, TeamAccess>()
let lookups = 0

function grant(permissions: string[] | null, owner = false): TeamAccess {
    return { owner, permissions }
}

function call(router: Router, user: object | null, probe: Probe) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        next()
    })
    app.use(router)
    return request(app)[probe.method](probe.path)
}

describe('switched route groups', () => {
    // These flows are not harness canvases, so the per-key harness list does not decide anything here.
    beforeAll(() => {
        setHarnessFlowLookup(async () => null)
        setHarnessKeyLookup(async () => null)
    })
    afterAll(() => {
        setHarnessFlowLookup(null)
        setHarnessKeyLookup(null)
    })

    beforeEach(() => {
        hits.n = 0
        lookups = 0
        memberships.clear()
        setTeamPermissionLookup({
            async accessFor(userId, workspaceId) {
                lookups += 1
                return memberships.get(`${userId}|${workspaceId}`) || { owner: false, permissions: null }
            }
        })
    })

    afterEach(() => setTeamPermissionLookup(null))

    it.each(groups)('$name allows the active team role, refuses a missing one, and skips the handler', async (group) => {
        memberships.set(`user-1|team-a`, grant([group.allow.permission]))
        const user = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: ['stale:nope'], isOrganizationAdmin: false }
        const allowed = await call(group.router, user, group.allow)
        expect(allowed.status).toBe(200)
        expect(user.permissions).toEqual(['stale:nope'])
        expect(hits.n).toBe(1)

        hits.n = 0
        memberships.set(`user-1|team-a`, grant(['unrelated:view']))
        const deniedUser = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: [group.allow.permission], isOrganizationAdmin: false }
        const denied = await call(group.router, deniedUser, group.allow)
        expect(denied.status).toBe(403)
        expect(denied.body).toEqual({ message: 'Forbidden' })
        expect(hits.n).toBe(0)
        expect(deniedUser.permissions).toEqual([group.allow.permission])
    })

    it.each(groups)('$name lets a database owner through without a team membership', async (group) => {
        memberships.set('owner|team-b', grant(null, true))
        const user = { id: 'owner', activeWorkspaceId: 'team-b', permissions: [], isOrganizationAdmin: false }
        const res = await call(group.router, user, group.allow)
        expect(res.status).toBe(200)
        expect(lookups).toBe(1)
        expect(hits.n).toBe(1)
        expect(user.permissions).toEqual([])
        expect(user.activeWorkspaceId).toBe('team-b')
    })

    it.each(groups)('$name allows an API key only by its own permissions', async (group) => {
        memberships.set('user-1|team-a', grant([group.allow.permission, group.anyOf.permission]))
        const key = { permissions: [group.allow.permission], isOrganizationAdmin: false, activeWorkspaceId: 'team-a' }
        expect((await call(group.router, key, group.allow)).status).toBe(200)
        expect(lookups).toBe(0)
        expect(key.permissions).toEqual([group.allow.permission])

        hits.n = 0
        lookups = 0
        const forged = { permissions: [], isOrganizationAdmin: true, activeWorkspaceId: 'team-a' }
        const denied = await call(group.router, forged, group.allow)
        expect(denied.status).toBe(403)
        expect(lookups).toBe(0)
        expect(hits.n).toBe(0)
    })

    it.each(groups)('$name refuses a role from another team even when the session snapshot has the string', async (group) => {
        memberships.set('user-1|team-a', grant([group.allow.permission]))
        memberships.set('user-1|team-b', grant(['unrelated:view']))
        const user = {
            id: 'user-1',
            activeWorkspaceId: 'team-b',
            permissions: [group.allow.permission],
            isOrganizationAdmin: false
        }
        const denied = await call(group.router, user, group.allow)
        expect(denied.status).toBe(403)
        expect(hits.n).toBe(0)
        expect(lookups).toBe(1)
        const home = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        expect((await call(group.router, home, group.allow)).status).toBe(200)
    })

    it('flow-versions restore refuses a view-only role', async () => {
        memberships.set('user-1|team-a', grant(['chatflows:view', 'agentflows:view']))
        const user = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        const res = await call(flowVersionsRouter, user, {
            method: 'post',
            path: '/0b5c3a1e-1111-2222-3333-444455556666/abcdef1/restore',
            permission: 'chatflows:view'
        })
        expect(res.status).toBe(403)
        expect(hits.n).toBe(0)
    })

    it.each([
        ['put', '/0b5c3a1e-1111-2222-3333-444455556666'],
        ['delete', '/0b5c3a1e-1111-2222-3333-444455556666'],
        ['put', '/0b5c3a1e-1111-2222-3333-444455556666/settings'],
        ['post', '/0b5c3a1e-1111-2222-3333-444455556666/publish'],
        ['post', '/0b5c3a1e-1111-2222-3333-444455556666/rollback']
    ] as [Method, string][])('flow-drafts %s %s refuses a view-only role', async (method, path) => {
        memberships.set('user-1|team-a', grant(['chatflows:view', 'agentflows:view']))
        const user = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        const res = await call(flowDraftsRouter, user, { method, path, permission: 'chatflows:view' })
        expect(res.status).toBe(403)
        expect(hits.n).toBe(0)
    })

    it.each([
        ['get', '/github'],
        ['put', '/github'],
        ['delete', '/github'],
        ['post', '/github/push'],
        ['post', '/github/repos'],
        ['post', '/github/repos/new'],
        ['put', '/environment'],
        ['get', '/incoming'],
        ['get', '/incoming/flow-1'],
        ['post', '/incoming/flow-1/promote'],
        ['get', '/incoming/flow-1/check'],
        ['post', '/incoming/flow-1/check'],
        ['get', '/incoming/flow-1/check/check-1'],
        ['delete', '/incoming/flow-1/check/check-1']
    ] as [Method, string][])('flow-versions %s %s is for the owner only', async (method, path) => {
        const everything = ['chatflows:view', 'chatflows:update', 'agentflows:update', 'users:manage', 'roles:manage', 'workspace:update']
        memberships.set('user-1|team-a', grant(everything))
        const admin = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: everything, isOrganizationAdmin: true }
        expect((await call(flowVersionsRouter, admin, { method, path, permission: '' })).status).toBe(403)
        const key = { permissions: everything, isOrganizationAdmin: true, activeWorkspaceId: 'team-a' }
        expect((await call(flowVersionsRouter, key, { method, path, permission: '' })).status).toBe(403)
        expect((await call(flowVersionsRouter, null, { method, path, permission: '' })).status).toBe(401)
        expect(hits.n).toBe(0)

        memberships.set('owner|team-b', grant(null, true))
        const owner = { id: 'owner', activeWorkspaceId: 'team-b', permissions: [], isOrganizationAdmin: false }
        expect((await call(flowVersionsRouter, owner, { method, path, permission: '' })).status).toBe(200)
        expect(hits.n).toBe(1)
    })

    it.each(groups)('$name accepts the any-of permission string on its own', async (group) => {
        memberships.set('user-1|team-a', grant([group.anyOf.permission]))
        const user = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        expect((await call(group.router, user, group.anyOf)).status).toBe(200)
        expect(hits.n).toBe(1)
    })

    it('model prices are for the owner only', async () => {
        const probes = [
            { method: 'get' as const, path: '/' },
            { method: 'put' as const, path: '/' },
            { method: 'delete' as const, path: '/' }
        ]
        const everything = ['chatflows:view', 'chatflows:update', 'agentflows:view', 'users:manage', 'roles:manage', 'workspace:update']
        memberships.set('user-1|team-a', grant(everything))
        const member = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: everything, isOrganizationAdmin: true }
        const key = { permissions: everything, isOrganizationAdmin: true, activeWorkspaceId: 'team-a' }
        for (const probe of probes) {
            expect((await call(modelPricesRouter, member, { ...probe, permission: '' })).status).toBe(403)
            expect((await call(modelPricesRouter, key, { ...probe, permission: '' })).status).toBe(403)
            expect((await call(modelPricesRouter, null, { ...probe, permission: '' })).status).toBe(401)
        }
        expect(hits.n).toBe(0)
        memberships.set('owner|team-b', grant(null, true))
        const owner = { id: 'owner', activeWorkspaceId: 'team-b', permissions: [], isOrganizationAdmin: false }
        for (const probe of probes) {
            expect((await call(modelPricesRouter, owner, { ...probe, permission: '' })).status).toBe(200)
        }
        expect(hits.n).toBe(3)
    })

    it('stats refuses tools:view and still loads for chatflows:view and the owner', async () => {
        memberships.set('user-1|team-a', grant(['tools:view']))
        const deniedSession = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: ['chatflows:view'], isOrganizationAdmin: false }
        expect((await call(statsRouter, deniedSession, { method: 'get', path: '/usage', permission: 'tools:view' })).status).toBe(403)
        const deniedKey = { permissions: ['tools:view'], activeWorkspaceId: 'team-a' }
        expect((await call(statsRouter, deniedKey, { method: 'get', path: '/usage', permission: 'tools:view' })).status).toBe(403)
        expect((await call(statsRouter, deniedKey, { method: 'get', path: '/flow-1', permission: 'tools:view' })).status).toBe(403)

        memberships.set('user-1|team-a', grant(['chatflows:view']))
        const viewer = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        expect((await call(statsRouter, viewer, { method: 'get', path: '/flow-1', permission: 'chatflows:view' })).status).toBe(200)
        const viewKey = { permissions: ['chatflows:view'], activeWorkspaceId: 'team-a' }
        expect((await call(statsRouter, viewKey, { method: 'get', path: '/usage', permission: 'chatflows:view' })).status).toBe(200)

        memberships.set('owner|team-b', grant(null, true))
        const owner = { id: 'owner', activeWorkspaceId: 'team-b', permissions: [], isOrganizationAdmin: false }
        expect((await call(statsRouter, owner, { method: 'get', path: '/flow-1', permission: '' })).status).toBe(200)
    })

    it('POST /credentials refuses a Viewer and allows a Builder', async () => {
        const probe = { method: 'post' as const, path: '/', permission: 'credentials:create' }
        const viewerKeys = builtInPermissionKeys('viewer') || []
        const builderKeys = builtInPermissionKeys('builder') || []
        expect(viewerKeys).toContain('credentials:view')
        expect(viewerKeys).not.toContain('credentials:create')
        expect(builderKeys).toContain('credentials:create')

        memberships.set('viewer|team-a', grant(viewerKeys))
        const viewer = { id: 'viewer', activeWorkspaceId: 'team-a', permissions: ['credentials:create'], isOrganizationAdmin: false }
        const denied = await call(credentialsRouter, viewer, probe)
        expect(denied.status).toBe(403)
        expect(denied.body).toEqual({ message: 'Forbidden' })
        expect(hits.n).toBe(0)

        memberships.set('builder|team-a', grant(builderKeys))
        const builder = { id: 'builder', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        expect((await call(credentialsRouter, builder, probe)).status).toBe(200)
        expect(hits.n).toBe(1)
    })

    it('has no credential reveal route: a Builder gets 404 and no controller runs', async () => {
        memberships.set('builder|team-a', grant(builtInPermissionKeys('builder') || []))
        const builder = { id: 'builder', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        for (const method of ['get', 'post', 'put'] as const) {
            const res = await call(credentialsRouter, builder, { method, path: '/cred-1/reveal', permission: 'credentials:update' })
            expect(res.status).toBe(404)
        }
        expect(hits.n).toBe(0)
        const routePaths = ((credentialsRouter as any).stack ?? [])
            .map((layer: any) => layer.route?.path)
            .filter((path: unknown) => path !== undefined)
            .flat()
            .map(String)
        expect(routePaths.length).toBeGreaterThan(0)
        expect(routePaths.filter((path: string) => /reveal/i.test(path))).toEqual([])
    })

    it('refuses check history for an API key that can run a check and cannot read messages', async () => {
        const path = '/0b5c3a1e-1111-2222-3333-444455556666/check/history'
        const key = { permissions: ['chatflows:update'], activeWorkspaceId: 'team-a' }
        const denied = await call(flowDraftsRouter, key, { method: 'get', path, permission: 'chatflows:update' })
        expect(denied.status).toBe(403)
        expect(hits.n).toBe(0)
        const allowed = { permissions: ['chatflows:view'], activeWorkspaceId: 'team-a' }
        expect((await call(flowDraftsRouter, allowed, { method: 'get', path, permission: 'chatflows:view' })).status).toBe(200)
    })

    it('answers 401 when the caller is missing, on each switched group', async () => {
        for (const group of groups) {
            hits.n = 0
            const res = await call(group.router, null, group.allow)
            expect(res.status).toBe(401)
            expect(res.body).toEqual({ message: 'Unauthorized' })
            expect(hits.n).toBe(0)
        }
    })

    it('leaves chatflow lookup by API key without a permission check', async () => {
        const res = await call(chatflowsRouter, null, { method: 'get', path: '/apikey/', permission: '' })
        expect(res.status).toBe(200)
        expect(hits.n).toBe(1)
    })
})
