import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-icon-cache-'))
const icon = path.join(dir, 'icon.svg')
fs.writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg"/>')

jest.mock('../../services/nodes', () => ({ __esModule: true, default: { getSingleNodeIcon: async () => icon } }))
jest.mock('../../services/components-credentials', () => ({
    __esModule: true,
    default: { getSingleComponentsCredentialIcon: async () => icon }
}))

import nodesController from './index'
import componentsCredentialsController from '../components-credentials'

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('icon responses', () => {
    const app = express()
    app.get('/node-icon/:name', nodesController.getSingleNodeIcon)
    app.get('/components-credentials-icon/:name', componentsCredentialsController.getSingleComponentsCredentialIcon)

    it.each(['/node-icon/openAI', '/components-credentials-icon/openAIApi'])('lets the browser keep %s for a day', async (url) => {
        const res = await request(app).get(url)
        expect(res.status).toBe(200)
        expect(res.headers['cache-control']).toBe('public, max-age=86400')
    })
})
