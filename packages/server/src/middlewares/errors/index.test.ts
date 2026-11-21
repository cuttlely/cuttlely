import express from 'express'
import multer from 'multer'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import errorHandlerMiddleware from './index'
import { toPredictionError } from '../../utils/predictionErrors'

jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    const nodeFs = jest.requireActual('fs')
    return { ...actual, removeSpecificFileFromUpload: jest.fn(async (file: string) => nodeFs.promises.unlink(file)) }
})

describe('upload size errors', () => {
    it('answers 400 when multer refuses a part over the file size limit', async () => {
        const app = express()
        app.post('/up', multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 } }).single('files'), (_req, res) => {
            res.json({ ok: true })
        })
        app.use(errorHandlerMiddleware)

        const res = await request(app)
            .post('/up')
            .attach('files', Buffer.from('0123456789'), { filename: 'note.txt', contentType: 'text/plain' })
        expect(res.status).toBe(400)
        expect(res.body.success).toBe(false)
        expect(res.body.message).toBe('File is too large to upload. The limit is 25 MB.')
    })
})

describe('a model provider rate limit', () => {
    it('answers 429 with the Retry-After header', async () => {
        const app = express()
        app.post('/api/v1/prediction/flow-1', (_req, _res, next) => {
            const provider = Object.assign(new Error('429 Rate limit reached'), {
                status: 429,
                headers: new Headers({ 'retry-after': '8' })
            })
            next(toPredictionError(provider))
        })
        app.use(errorHandlerMiddleware)

        const res = await request(app).post('/api/v1/prediction/flow-1').send({ question: 'Is rye baked today?' })
        expect(res.status).toBe(429)
        expect(res.headers['retry-after']).toBe('8')
        expect(res.body).toMatchObject({ statusCode: 429, success: false })
    })

    it('sends no Retry-After for other errors', async () => {
        const app = express()
        app.get('/boom', (_req, _res, next) => next(toPredictionError(new Error('boom'))))
        app.use(errorHandlerMiddleware)
        const res = await request(app).get('/boom')
        expect(res.status).toBe(500)
        expect(res.headers['retry-after']).toBeUndefined()
    })
})

describe('a request refused because the agent runtime is down', () => {
    it('removes the multipart files multer already stored and still answers 503 RUNTIME_UNAVAILABLE', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-refusal-'))
        const app = express()
        app.post('/api/v1/prediction/flow-1', multer({ dest: dir }).array('files'), (_req, _res, next) => {
            next(
                Object.assign(new Error('The agent runtime is restarting. Try again shortly.'), {
                    statusCode: 503,
                    code: 'RUNTIME_UNAVAILABLE',
                    retryAfterSeconds: 5
                })
            )
        })
        app.use(errorHandlerMiddleware)
        try {
            const res = await request(app)
                .post('/api/v1/prediction/flow-1')
                .attach('files', Buffer.from('rye and spelt'), { filename: 'menu.txt', contentType: 'text/plain' })
            expect(res.status).toBe(503)
            expect(res.body.code).toBe('RUNTIME_UNAVAILABLE')
            expect(res.headers['retry-after']).toBe('5')
            expect(fs.readdirSync(dir)).toEqual([])
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
