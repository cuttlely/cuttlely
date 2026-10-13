import express, { Request } from 'express'
import request from 'supertest'
import modelPricesController from './index'

const queries: string[] = []

jest.mock('@cuttlely/components', () => ({
    getRawModelFile: async () => ({
        chat: [{ models: [{ name: 'gpt-4.1-mini', input_cost: 0.0000004, output_cost: 0.0000016 }] }],
        llm: [],
        embedding: []
    })
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            options: { type: 'sqlite' },
            query: async (sql: string) => {
                queries.push(sql)
                if (sql.includes('workspace')) return [{ organizationId: 'org-1' }]
                return []
            }
        }
    })
}))

function appFor(user: object | null) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
        if (user) (req as Request).user = user as Express.User
        next()
    })
    app.get('/', modelPricesController.list)
    app.put('/', modelPricesController.set)
    app.delete('/', modelPricesController.clear)
    app.use(
        (error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            res.status(error.statusCode || 500).json({ message: error.message })
        }
    )
    return app
}

describe('model price routes', () => {
    beforeEach(() => {
        queries.length = 0
    })

    it('refuses a caller with no workspace and a price that is not a number', async () => {
        const app = appFor({ id: 'user-1' })
        expect((await request(app).get('/')).status).toBe(401)
        const denied = await request(appFor({ id: 'user-1', activeWorkspaceId: 'ws-1' }))
            .put('/')
            .send({ model: 'gpt-4.1-mini', input: -1, output: 2 })
        expect(denied.status).toBe(400)
        expect(denied.body.message).toContain('input')
        expect(queries.some((sql) => sql.includes('INSERT'))).toBe(false)
        const missing = await request(appFor({ id: 'user-1', activeWorkspaceId: 'ws-1' }))
            .delete('/')
            .send({})
        expect(missing.status).toBe(400)
    })

    it('returns the default, and a set writes an override the response shows', async () => {
        const app = appFor({ id: 'owner', activeWorkspaceId: 'ws-1' })
        const listed = await request(app).get('/')
        expect(listed.status).toBe(200)
        expect(listed.body.unit).toBe('usd_per_million_tokens')
        expect(listed.body.estimates).toBe(true)
        expect(listed.body.models).toEqual([
            {
                model: 'gpt-4.1-mini',
                default: { input: 0.4, output: 1.6 },
                override: null,
                effective: { input: 0.4, output: 1.6 }
            }
        ])
        const saved = await request(app).put('/').send({ model: 'custom-bakery', input: 1, output: 2 })
        expect(saved.status).toBe(200)
        expect(queries.some((sql) => sql.includes('INSERT'))).toBe(true)
        expect(saved.body.model).toBe('custom-bakery')
        expect(saved.body.default).toBeNull()
    })
})
