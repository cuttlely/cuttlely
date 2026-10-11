import express from 'express'
import http from 'http'
import multer from 'multer'
import { AddressInfo } from 'net'
import { Readable } from 'stream'
import { AzureBlobMulterStorage } from './AzureBlobMulterStorage'

type StoredBlob = { data: Buffer; contentType?: string; disposition?: string }

// The parts of ContainerClient the storage engine uses, kept in memory.
const fakeContainer = () => {
    const blobs = new Map<string, StoredBlob>()
    const deleted: string[] = []
    let created = 0
    const client = {
        createIfNotExists: async () => {
            created += 1
            return {}
        },
        getBlockBlobClient: (name: string) => ({
            uploadStream: async (stream: Readable, _bufferSize?: number, _maxConcurrency?: number, options?: any) => {
                const chunks: Buffer[] = []
                for await (const chunk of stream) chunks.push(Buffer.from(chunk))
                blobs.set(name, {
                    data: Buffer.concat(chunks),
                    contentType: options?.blobHTTPHeaders?.blobContentType,
                    disposition: options?.blobHTTPHeaders?.blobContentDisposition
                })
                return { etag: '"etag-1"' }
            },
            deleteIfExists: async () => {
                deleted.push(name)
                blobs.delete(name)
                return { succeeded: true }
            }
        })
    }
    return { client: client as any, blobs, deleted, createdCount: () => created }
}

const listen = (app: express.Express) =>
    new Promise<http.Server>((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server))
    })

const postFile = (port: number, filename: string, bytes: Uint8Array, type = 'text/plain') => {
    const form = new FormData()
    form.append('files', new Blob([bytes], { type }), filename)
    return fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', body: form })
}

const serve = async (container: ReturnType<typeof fakeContainer>, limits?: multer.Options['limits']) => {
    let counter = 0
    const storage = new AzureBlobMulterStorage(container.client, (_req, file) => `uploads/id-${++counter}/${file.originalname}`)
    const app = express()
    app.post('/up', multer({ storage, limits }).array('files'), (req, res) => {
        res.json((req.files as any[]).map(({ path, blobName, size, etag, originalname }) => ({ path, blobName, size, etag, originalname })))
    })
    app.use((err: { code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(400).json({ code: err.code })
    })
    const server = await listen(app)
    return { server, port: (server.address() as AddressInfo).port }
}

const close = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()))

describe('Azure Blob Storage uploads', () => {
    it('streams the file into the container and reports the blob name as the path', async () => {
        const container = fakeContainer()
        const { server, port } = await serve(container)
        try {
            const res = await postFile(port, 'notes.txt', new TextEncoder().encode('hello azure'))
            expect(res.status).toBe(200)
            const [file] = (await res.json()) as any[]
            expect(file).toEqual({
                path: 'uploads/id-1/notes.txt',
                blobName: 'uploads/id-1/notes.txt',
                size: 11,
                etag: '"etag-1"',
                originalname: 'notes.txt'
            })
            const blob = container.blobs.get('uploads/id-1/notes.txt')
            expect(blob?.data.toString()).toBe('hello azure')
            expect(blob?.contentType).toBe('text/plain')
            expect(blob?.disposition).toBe('inline')
            expect(container.createdCount()).toBe(1)
        } finally {
            await close(server)
        }
    })

    it('refuses a file above the size limit and deletes what was written', async () => {
        const container = fakeContainer()
        const { server, port } = await serve(container, { fileSize: 8 })
        try {
            const res = await postFile(port, 'big.bin', new Uint8Array(64), 'application/octet-stream')
            expect(res.status).toBe(400)
            expect(((await res.json()) as any).code).toBe('LIMIT_FILE_SIZE')
            expect(container.deleted).toEqual(['uploads/id-1/big.bin'])
            expect(container.blobs.size).toBe(0)
        } finally {
            await close(server)
        }
    })

    it('passes a container error to multer', async () => {
        const container = fakeContainer()
        container.client.createIfNotExists = async () => {
            throw Object.assign(new Error('denied'), { code: 'AuthorizationFailure' })
        }
        const { server, port } = await serve(container)
        try {
            const res = await postFile(port, 'notes.txt', new Uint8Array([1, 2, 3]))
            expect(res.status).toBe(400)
            expect(((await res.json()) as any).code).toBe('AuthorizationFailure')
            expect(container.blobs.size).toBe(0)
        } finally {
            await close(server)
        }
    })
})
