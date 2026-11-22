import fs from 'fs'
import os from 'os'
import path from 'path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-errors-'))
const storageEnv = ['HOME', 'DATABASE_PATH', 'CUTTLELY_DATA_DIR', 'HERMES_HOME'] as const
const savedEnv = Object.fromEntries(storageEnv.map((name) => [name, process.env[name]]))
for (const name of storageEnv) process.env[name] = dataDir

import express from 'express'
import multer from 'multer'
import request from 'supertest'
import { MissingModelCredentialError, missingModelCredentialMessage } from '@cuttlely/components'
import { fromQueueFailure } from '../../errors/utils'
import errorHandlerMiddleware from './index'
import { toPredictionError } from '../../utils/predictionErrors'

jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    const nodeFs = jest.requireActual('fs')
    return { ...actual, removeSpecificFileFromUpload: jest.fn(async (file: string) => nodeFs.promises.unlink(file)) }
})

afterAll(() => {
    for (const name of storageEnv) {
        if (savedEnv[name] === undefined) delete process.env[name]
        else process.env[name] = savedEnv[name]
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('queue credential failures', () => {
    it.each(['Bakery embeddings', 'Model (west) [1].*', 'chat model', 'Bakery\nmodel'])(
        'restores the class and 422 for the exact message naming %s',
        async (label) => {
            const failedReason = missingModelCredentialMessage(label)
            await expect(Promise.reject(new Error(failedReason)).catch(fromQueueFailure)).rejects.toBeInstanceOf(
                MissingModelCredentialError
            )
            await expect(Promise.reject(new Error(failedReason)).catch(fromQueueFailure)).rejects.toMatchObject({
                statusCode: 422,
                message: failedReason
            })
        }
    )

    it.each([
        'Vector service unavailable',
        'Error: Pick a credential on the Bakery model node.',
        'Pick a credential on the Bakery model node. Please retry.',
        'Pick a credential on the Bakery model node.\n',
        'Pick a credential on the  Bakery model node.',
        'Pick a credential on the Bakery model  node.',
        'Pick a credential on the  node.',
        'pick a credential on the Bakery model node.'
    ])('rethrows other reasons untouched: %s', async (reason) => {
        const failure = new Error(reason)
        await expect(Promise.reject(failure).catch(fromQueueFailure)).rejects.toBe(failure)
    })

    it.each([undefined, null, 'Pick a credential on the Bakery model node.', { reason: 'worker failed' }])(
        'rethrows non-error failures untouched: %s',
        async (failure) => {
            await expect(Promise.reject(failure).catch(fromQueueFailure)).rejects.toBe(failure)
        }
    )
})

describe('a missing model credential', () => {
    it('answers 422 with the card message for a component error', async () => {
        const app = express()
        app.post('/run', (_req, _res, next) => next(new MissingModelCredentialError('Bakery model')))
        app.use(errorHandlerMiddleware)

        const res = await request(app).post('/run')
        expect(res.status).toBe(422)
        expect(res.body).toMatchObject({ statusCode: 422, success: false, message: missingModelCredentialMessage('Bakery model') })
    })
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
