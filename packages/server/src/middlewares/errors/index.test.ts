import express from 'express'
import multer from 'multer'
import request from 'supertest'
import errorHandlerMiddleware from './index'

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
