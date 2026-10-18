import express from 'express'
import request from 'supertest'
import exportImportRouter from './index'

// importData in services/export-import does not run the harness checks a chatflow save runs (D91). It is safe only
// while this route stays closed; reopening it needs those checks on every imported canvas, and this test changed.
describe('workspace export and import', () => {
    it('stays closed for every method and path', async () => {
        const app = express()
        app.use(express.json())
        app.use('/api/v1/export-import', exportImportRouter)
        for (const [method, path] of [
            ['post', '/api/v1/export-import/import'],
            ['post', '/api/v1/export-import/export'],
            ['get', '/api/v1/export-import'],
            ['put', '/api/v1/export-import/import']
        ] as const) {
            const res = await request(app)
                [method](path)
                .send({ ChatFlow: [{ flowData: '{"harnessName":["payroll"]}' }] })
            expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 })
        }
    })
})
