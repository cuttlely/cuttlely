import express from 'express'
import multer from 'multer'
import request from 'supertest'
import errorHandlerMiddleware from './index'
import { toPredictionError } from '../../utils/predictionErrors'

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
