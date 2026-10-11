import type { Request } from 'express'
import type { ContainerClient } from '@azure/storage-blob'
import type multer from 'multer'
import { Transform, pipeline } from 'stream'

type UploadedFile = Express.Multer.File & { blobName?: string; etag?: string }

/**
 * Multer storage engine that streams each upload into one Azure Blob Storage container with the official SDK.
 * The server reads an uploaded file through file.path (local and GCS) or file.key (S3), so path carries the blob name.
 */
export class AzureBlobMulterStorage implements multer.StorageEngine {
    constructor(
        private readonly containerClient: ContainerClient,
        private readonly blobName: (req: Request, file: Express.Multer.File) => string
    ) {}

    _handleFile(req: Request, file: Express.Multer.File, cb: (error?: any, info?: Partial<UploadedFile>) => void): void {
        this.upload(req, file).then(
            (info) => cb(null, info),
            (error) => cb(error)
        )
    }

    _removeFile(_req: Request, file: UploadedFile, cb: (error: Error | null) => void): void {
        const name = file.blobName ?? file.path
        if (!name) {
            cb(null)
            return
        }
        this.containerClient
            .getBlockBlobClient(name)
            .deleteIfExists()
            .then(
                () => cb(null),
                (error) => cb(error)
            )
    }

    private async upload(req: Request, file: Express.Multer.File): Promise<Partial<UploadedFile>> {
        const name = this.blobName(req, file)
        await this.containerClient.createIfNotExists()
        const blob = this.containerClient.getBlockBlobClient(name)

        let size = 0
        const counter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                size += chunk.length
                done(null, chunk)
            }
        })
        // pipeline destroys the counter when multer aborts the file stream (for example at the size limit), so the upload fails too.
        pipeline(file.stream, counter, () => undefined)

        const result = await blob.uploadStream(counter, undefined, undefined, {
            blobHTTPHeaders: { blobContentType: file.mimetype, blobContentDisposition: 'inline' }
        })
        return { path: name, blobName: name, size, etag: result.etag }
    }
}
