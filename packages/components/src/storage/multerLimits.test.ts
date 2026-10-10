import express from 'express'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import { MULTER_FILE_SIZE_LIMIT } from '../documentUploadCapabilities'
import { LocalStorageProvider } from './LocalStorageProvider'

const listen = (app: express.Express) =>
    new Promise<http.Server>((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server))
    })

const postFile = async (port: number, filename: string, bytes: Uint8Array) => {
    const form = new FormData()
    form.append('files', new Blob([bytes]), filename)
    return fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', body: form })
}

describe('multer file size limit', () => {
    const providers = ['LocalStorageProvider.ts', 'S3StorageProvider.ts', 'GCSStorageProvider.ts', 'AzureBlobStorageProvider.ts']

    it('passes the shared cap into every storage provider', () => {
        for (const file of providers) {
            const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
            expect(src).toContain('documentUploadMulterLimits()')
        }
    })

    it('refuses a local upload above the cap and accepts a small file', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-multer-'))
        const previous = process.env.BLOB_STORAGE_PATH
        process.env.BLOB_STORAGE_PATH = dir
        const app = express()
        app.post('/up', new LocalStorageProvider().getMulterStorage().single('files'), (_req, res) => {
            res.json({ ok: true })
        })
        app.use((err: { code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            res.status(400).json({ code: err.code, message: err.message })
        })
        const server = await listen(app)
        try {
            const port = (server.address() as AddressInfo).port
            const ok = await postFile(port, 'note.txt', new Uint8Array([1, 2, 3]))
            expect(ok.status).toBe(200)
            const blocked = await postFile(port, 'big.txt', new Uint8Array(MULTER_FILE_SIZE_LIMIT + 1))
            expect(blocked.status).toBe(400)
            const body = (await blocked.json()) as { code?: string }
            expect(body.code).toBe('LIMIT_FILE_SIZE')
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
            if (previous === undefined) delete process.env.BLOB_STORAGE_PATH
            else process.env.BLOB_STORAGE_PATH = previous
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }, 30000)
})
