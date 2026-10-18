/**
 * The node palette requests every node icon on a cold load. At the lowest supported
 * CUTTLELY_UI_PAGE_LIMIT_MAX (100) that load, and a second one from another tab, must not
 * get a 429, and the icon routers must still answer 429 once the budget is spent.
 */
import http from 'http'
import path from 'path'
import express from 'express'
import request from 'supertest'

const catalog: { nodes: Array<{ name: string }> } = require(path.join(__dirname, '../../../components/nodes/module-catalog.json'))
const NODE_NAMES = catalog.nodes.map((node) => node.name)
const CREDENTIAL_COUNT = 150

jest.mock('../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        nodesPool: {
            componentNodes: Object.fromEntries(NODE_NAMES.map((name) => [name, {}])),
            componentCredentials: Object.fromEntries(Array.from({ length: CREDENTIAL_COUNT }, (_v, i) => [`cred${i}`, {}]))
        }
    })
}))

jest.mock('../controllers/nodes', () => {
    const actual = jest.requireActual('../controllers/nodes')
    return {
        __esModule: true,
        default: { ...actual.default, getSingleNodeIcon: (_req: express.Request, res: express.Response) => res.end('icon') }
    }
})

jest.mock('../controllers/components-credentials', () => {
    const actual = jest.requireActual('../controllers/components-credentials')
    return {
        __esModule: true,
        default: { ...actual.default, getSingleComponentsCredentialIcon: (_req: express.Request, res: express.Response) => res.end('icon') }
    }
})

import apiRouter from './index'
import { UI_ICON_CATALOG_LOADS, uiPageLimitMax } from '../utils/rateLimit'
import { resetRuntimeLimitsForTests } from '../settings/runtime'
import { HOST_KEYS_VAR } from '../settings/resolve'

jest.setTimeout(120_000)

const PAGE_LIMIT = 100

async function statuses(server: http.Server, urls: string[]): Promise<number[]> {
    const out: number[] = []
    for (const url of urls) out.push((await request(server).get(url).timeout({ response: 20_000, deadline: 20_000 })).status)
    return out
}

describe('icon routers at CUTTLELY_UI_PAGE_LIMIT_MAX=100', () => {
    const previous = { limit: process.env.CUTTLELY_UI_PAGE_LIMIT_MAX, hostKeys: process.env[HOST_KEYS_VAR] }
    let server: http.Server

    const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }

    beforeAll(() => {
        process.env.CUTTLELY_UI_PAGE_LIMIT_MAX = String(PAGE_LIMIT)
        process.env[HOST_KEYS_VAR] = 'CUTTLELY_UI_PAGE_LIMIT_MAX'
        resetRuntimeLimitsForTests()
        const app = express()
        app.use('/api/v1', apiRouter)
        server = app.listen(0)
    })

    afterAll(() => {
        server.close()
        restore('CUTTLELY_UI_PAGE_LIMIT_MAX', previous.limit)
        restore(HOST_KEYS_VAR, previous.hostKeys)
        resetRuntimeLimitsForTests()
    })

    it('serves two cold node palette loads of the shipped catalog, then answers 429 past the budget', async () => {
        expect(uiPageLimitMax()).toBe(PAGE_LIMIT)
        expect(NODE_NAMES.length).toBeGreaterThan(PAGE_LIMIT)
        const palette = NODE_NAMES.map((name) => `/api/v1/node-icon/${name}`)
        const twoLoads = await statuses(server, [...palette, ...palette])
        expect(twoLoads.filter((status) => status !== 200)).toEqual([])

        const budget = PAGE_LIMIT + UI_ICON_CATALOG_LOADS * NODE_NAMES.length
        const rest = await statuses(
            server,
            Array.from({ length: budget - twoLoads.length + 1 }, () => palette[0])
        )
        expect(rest.slice(0, -1).filter((status) => status !== 200)).toEqual([])
        expect(rest[rest.length - 1]).toBe(429)
    })

    it('serves a cold load of every credential icon', async () => {
        const icons = Array.from({ length: CREDENTIAL_COUNT }, (_v, i) => `/api/v1/components-credentials-icon/cred${i}`)
        expect((await statuses(server, icons)).filter((status) => status !== 200)).toEqual([])
    })
})
