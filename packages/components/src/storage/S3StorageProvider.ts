import {
    DeleteObjectsCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    S3ClientConfig
} from '@aws-sdk/client-s3'
import multer from 'multer'
import multerS3 from 'multer-s3'
import { Readable } from 'node:stream'
import { v4 as uuidv4 } from 'uuid'
import { transports } from 'winston'
import { BaseStorageProvider } from './BaseStorageProvider'
import { documentUploadMulterLimits } from './multerLimits'
import { FileInfo, StorageResult, StorageSizeResult } from './IStorageProvider'

const { S3StreamLogger } = require('s3-streamlogger')

export class S3StorageProvider extends BaseStorageProvider {
    private s3Client: S3Client
    private bucket: string
    private s3Config: S3ClientConfig

    constructor() {
        super()
        const config = this.initS3Config()
        this.s3Client = config.s3Client
        this.bucket = config.bucket
        this.s3Config = config.s3Config
    }

    private initS3Config(): { s3Client: S3Client; bucket: string; s3Config: S3ClientConfig } {
        const accessKeyId = process.env.S3_STORAGE_ACCESS_KEY_ID
        const secretAccessKey = process.env.S3_STORAGE_SECRET_ACCESS_KEY
        const region = process.env.S3_STORAGE_REGION
        const bucket = process.env.S3_STORAGE_BUCKET_NAME
        const customURL = process.env.S3_ENDPOINT_URL
        const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true'

        if (!region || region.trim() === '' || !bucket || bucket.trim() === '') {
            throw new Error('S3 storage configuration is missing')
        }

        const s3Config: S3ClientConfig = {
            region,
            forcePathStyle,
            ...(customURL && customURL.trim() !== '' ? { endpoint: customURL } : {}),
            ...(accessKeyId && accessKeyId.trim() !== '' && secretAccessKey && secretAccessKey.trim() !== ''
                ? { credentials: { accessKeyId, secretAccessKey } }
                : {})
        }

        const s3Client = new S3Client(s3Config)
        return { s3Client, bucket, s3Config }
    }

    getStorageType(): string {
        return 's3'
    }

    getConfig(): any {
        return {
            bucket: this.bucket,
            region: process.env.S3_STORAGE_REGION,
            endpoint: process.env.S3_ENDPOINT_URL
        }
    }

    async addBase64FilesToStorage(fileBase64: string, chatflowid: string, fileNames: string[], orgId: string): Promise<StorageResult> {
        // Validate chatflowid
        this.validateChatflowId(chatflowid)
        this.validatePathSecurity(chatflowid)

        const splitDataURI = fileBase64.split(',')
        const filename = splitDataURI.pop()?.split(':')[1] ?? ''
        const bf = Buffer.from(splitDataURI.pop() || '', 'base64')
        const mime = splitDataURI[0].split(':')[1].split(';')[0]

        const sanitizedFilename = this.sanitizeFilename(filename)
        const Key = orgId + '/' + chatflowid + '/' + sanitizedFilename

        const putObjCmd = new PutObjectCommand({
            Bucket: this.bucket,
            Key,
            ContentEncoding: 'base64',
            ContentType: mime,
            Body: bf
        })
        await this.s3Client.send(putObjCmd)

        fileNames.push(sanitizedFilename)
        const totalSize = await this.getStorageSize(orgId)

        return { path: 'FILE-STORAGE::' + JSON.stringify(fileNames), totalSize: totalSize / 1024 / 1024 }
    }

    async addArrayFilesToStorage(
        mime: string,
        bf: Buffer,
        fileName: string,
        fileNames: string[],
        ...paths: string[]
    ): Promise<StorageResult> {
        const sanitizedFilename = this.sanitizeFilename(fileName)

        let Key = paths.reduce((acc, cur) => acc + '/' + cur, '') + '/' + sanitizedFilename
        if (Key.startsWith('/')) {
            Key = Key.substring(1)
        }

        const putObjCmd = new PutObjectCommand({
            Bucket: this.bucket,
            Key,
            ContentEncoding: 'base64',
            ContentType: mime,
            Body: bf
        })
        await this.s3Client.send(putObjCmd)
        fileNames.push(sanitizedFilename)

        const totalSize = await this.getStorageSize(paths[0])
        return { path: 'FILE-STORAGE::' + JSON.stringify(fileNames), totalSize: totalSize / 1024 / 1024 }
    }

    async addSingleFileToStorage(mime: string, bf: Buffer, fileName: string, ...paths: string[]): Promise<StorageResult> {
        const sanitizedFilename = this.sanitizeFilename(fileName)

        let Key = paths.reduce((acc, cur) => acc + '/' + cur, '') + '/' + sanitizedFilename
        if (Key.startsWith('/')) {
            Key = Key.substring(1)
        }

        const putObjCmd = new PutObjectCommand({
            Bucket: this.bucket,
            Key,
            ContentEncoding: 'base64',
            ContentType: mime,
            Body: bf
        })
        await this.s3Client.send(putObjCmd)

        const totalSize = await this.getStorageSize(paths[0])
        return { path: 'FILE-STORAGE::' + sanitizedFilename, totalSize: totalSize / 1024 / 1024 }
    }

    async getFileFromUpload(filePath: string): Promise<Buffer> {
        // For S3, the filePath is the S3 key
        let Key = filePath
        if (Key.startsWith('/')) {
            Key = Key.substring(1)
        }

        const getParams = {
            Bucket: this.bucket,
            Key
        }

        const response = await this.s3Client.send(new GetObjectCommand(getParams))
        return Buffer.from(await response.Body!.transformToByteArray())
    }

    async getFileFromStorage(file: string, ...paths: string[]): Promise<Buffer> {
        const sanitizedFilename = this.sanitizeFilename(file)

        let Key = paths.reduce((acc, cur) => acc + '/' + cur, '') + '/' + sanitizedFilename
        if (Key.startsWith('/')) {
            Key = Key.substring(1)
        }

        try {
            const getParams = {
                Bucket: this.bucket,
                Key
            }

            const response = await this.s3Client.send(new GetObjectCommand(getParams))
            return Buffer.from(await response.Body!.transformToByteArray())
        } catch (error) {
            // Fallback: Check if file exists without the first path element (likely orgId)
            if (paths.length > 1) {
                const fallbackPaths = paths.slice(1)
                let fallbackKey = fallbackPaths.reduce((acc, cur) => acc + '/' + cur, '') + '/' + sanitizedFilename
                if (fallbackKey.startsWith('/')) {
                    fallbackKey = fallbackKey.substring(1)
                }

                try {
                    const fallbackParams = {
                        Bucket: this.bucket,
                        Key: fallbackKey
                    }
                    const fallbackResponse = await this.s3Client.send(new GetObjectCommand(fallbackParams))
                    const fileContent = Buffer.from(await fallbackResponse.Body!.transformToByteArray())

                    // Move to correct location with orgId
                    const putObjCmd = new PutObjectCommand({
                        Bucket: this.bucket,
                        Key,
                        Body: fileContent
                    })
                    await this.s3Client.send(putObjCmd)

                    // Delete the old file
                    await this.s3Client.send(
                        new DeleteObjectsCommand({
                            Bucket: this.bucket,
                            Delete: {
                                Objects: [{ Key: fallbackKey }],
                                Quiet: false
                            }
                        })
                    )

                    // Check if the directory is empty and delete recursively if needed
                    if (fallbackPaths.length > 0) {
                        await this.cleanEmptyS3Folders(fallbackPaths[0])
                    }

                    return fileContent
                } catch (fallbackError) {
                    throw error
                }
            } else {
                throw error
            }
        }
    }

    async streamStorageFile(chatflowId: string, chatId: string, fileName: string, orgId: string): Promise<Buffer | undefined> {
        // Validate chatflowId and chatId
        this.validateChatflowId(chatflowId)
        this.validatePathSecurity(chatflowId, chatId)

        const sanitizedFilename = this.sanitizeFilename(fileName)
        const Key = orgId + '/' + chatflowId + '/' + chatId + '/' + sanitizedFilename

        const getParams = {
            Bucket: this.bucket,
            Key
        }

        try {
            const response = await this.s3Client.send(new GetObjectCommand(getParams))
            const body = response.Body
            if (body instanceof Readable) {
                const blob = await body.transformToByteArray()
                return Buffer.from(blob)
            }
        } catch (error) {
            // Fallback: Check if file exists without orgId
            const fallbackKey = chatflowId + '/' + chatId + '/' + sanitizedFilename
            try {
                const fallbackParams = {
                    Bucket: this.bucket,
                    Key: fallbackKey
                }
                const fallbackResponse = await this.s3Client.send(new GetObjectCommand(fallbackParams))
                const fallbackBody = fallbackResponse.Body

                // If found, copy to correct location with orgId
                if (fallbackBody) {
                    let fileContent: Buffer
                    if (fallbackBody instanceof Readable) {
                        const blob = await fallbackBody.transformToByteArray()
                        fileContent = Buffer.from(blob)
                    } else {
                        const byteArray = await fallbackBody.transformToByteArray()
                        fileContent = Buffer.from(byteArray)
                    }

                    // Move to correct location with orgId
                    const putObjCmd = new PutObjectCommand({
                        Bucket: this.bucket,
                        Key,
                        Body: fileContent
                    })
                    await this.s3Client.send(putObjCmd)

                    // Delete the old file
                    await this.s3Client.send(
                        new DeleteObjectsCommand({
                            Bucket: this.bucket,
                            Delete: {
                                Objects: [{ Key: fallbackKey }],
                                Quiet: false
                            }
                        })
                    )

                    // Check if the directory is empty and delete recursively if needed
                    await this.cleanEmptyS3Folders(chatflowId)

                    return fileContent
                }
            } catch (fallbackError) {
                throw new Error(`File ${fileName} not found`)
            }
        }
    }

    async getFilesListFromStorage(...paths: string[]): Promise<FileInfo[]> {
        const result: FileInfo[] = []
        for await (const page of this.folderPages(paths)) {
            for (const object of page) {
                if (object.Key) result.push({ name: object.Key.split('/').pop() || '', path: object.Key, size: object.Size || 0 })
            }
        }
        return result
    }

    private async *folderPages(paths: string[]) {
        const key = paths.join('/')
        let start = 0
        let end = key.length
        while (start < end && key[start] === '/') start++
        while (end > start && key[end - 1] === '/') end--
        if (start === end) throw new Error('A scoped S3 folder is required.')
        const folder = key.slice(start, end)
        let token: string | undefined
        do {
            const page = await this.s3Client.send(
                new ListObjectsV2Command({
                    Bucket: this.bucket,
                    Prefix: folder + '/',
                    ContinuationToken: token
                })
            )
            yield page.Contents || []
            token = page.NextContinuationToken
        } while (token)
    }

    async openPredictionFile(segments: string[]) {
        if (
            segments[0] !== 'blobs' ||
            segments.length < 3 ||
            segments.some((part) => !part || part === '.' || part === '..' || /[/\\]/.test(part))
        )
            throw new Error('Invalid attachment key.')
        const response = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucket, Key: segments.slice(1).join('/') }))
        if (!(response.Body instanceof Readable)) throw new Error('Could not read the stored attachment.')
        return response.Body
    }

    async removeFilesFromStorage(...paths: string[]): Promise<StorageSizeResult> {
        for await (const page of this.folderPages(paths)) {
            const objects = page.flatMap((object) => (object.Key ? [{ Key: object.Key }] : []))
            if (!objects.length) continue
            const deleted = await this.s3Client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }))
            if (deleted.Errors?.length) throw new Error('The object store did not delete every requested file.')
        }
        return { totalSize: (await this.getStorageSize(paths[0])) / 1024 / 1024 }
    }

    async removeSpecificFileFromUpload(filePath: string): Promise<void> {
        await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: filePath.replace(/^\//, '') }))
    }

    async removeSpecificFileFromStorage(...paths: string[]): Promise<StorageSizeResult> {
        await this.removeSpecificFileFromUpload(paths.join('/'))
        return { totalSize: (await this.getStorageSize(paths[0])) / 1024 / 1024 }
    }

    async removeFolderFromStorage(...paths: string[]): Promise<StorageSizeResult> {
        return this.removeFilesFromStorage(...paths)
    }

    private async cleanEmptyS3Folders(prefix: string): Promise<void> {
        try {
            if (!prefix) return

            const listCmd = new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: prefix + '/',
                Delimiter: '/'
            })

            const response = await this.s3Client.send(listCmd)

            if (
                (response.Contents?.length === 0 || !response.Contents) &&
                (response.CommonPrefixes?.length === 0 || !response.CommonPrefixes)
            ) {
                await this.s3Client.send(
                    new DeleteObjectsCommand({
                        Bucket: this.bucket,
                        Delete: {
                            Objects: [{ Key: prefix + '/' }],
                            Quiet: true
                        }
                    })
                )

                const parentPrefix = prefix.substring(0, prefix.lastIndexOf('/'))
                if (parentPrefix) {
                    await this.cleanEmptyS3Folders(parentPrefix)
                }
            }
        } catch (error) {
            console.error('Error cleaning empty S3 folders:', error)
        }
    }

    async getStorageSize(orgId: string): Promise<number> {
        if (!orgId) return 0

        let totalSize = 0
        for await (const page of this.folderPages([orgId])) {
            for (const object of page) totalSize += object.Size || 0
        }
        return totalSize
    }

    getMulterStorage(): multer.Multer {
        return multer({
            limits: documentUploadMulterLimits(),
            storage: multerS3({
                s3: this.s3Client,
                bucket: this.bucket,
                // Use the private bucket policy. IBM COS and ACL-disabled S3 buckets reject object ACL headers.
                acl: (_req, _file, done) => done(null),
                metadata: function (req: any, file: any, cb: any) {
                    cb(null, { fieldName: file.fieldname, originalName: file.originalname })
                },
                key: function (req: any, file: any, cb: any) {
                    cb(null, `${uuidv4()}`)
                }
            })
        })
    }

    getLoggerTransports(logType: 'server' | 'error' | 'requests' | 'audit'): any[] {
        if (logType === 'server') {
            const s3ServerStream = new S3StreamLogger({
                bucket: this.bucket,
                folder: 'logs/server',
                name_format: `server-%Y-%m-%d-%H-%M-%S-%L.log`,
                config: this.s3Config
            })
            return [new transports.Stream({ stream: s3ServerStream })]
        } else if (logType === 'error') {
            const s3ErrorStream = new S3StreamLogger({
                bucket: this.bucket,
                folder: 'logs/error',
                name_format: `server-error-%Y-%m-%d-%H-%M-%S-%L.log`,
                config: this.s3Config
            })
            return [new transports.Stream({ stream: s3ErrorStream })]
        } else if (logType === 'requests') {
            const s3ServerReqStream = new S3StreamLogger({
                bucket: this.bucket,
                folder: 'logs/requests',
                name_format: `server-requests-%Y-%m-%d-%H-%M-%S-%L.log.jsonl`,
                config: this.s3Config
            })
            return [new transports.Stream({ stream: s3ServerReqStream })]
        } else if (logType === 'audit') {
            const instance = process.env.HOSTNAME || process.env.POD_NAME || String(process.pid)
            const s3AuditStream = new S3StreamLogger({
                bucket: this.bucket,
                folder: 'logs/audit',
                name_format: `audit-%Y-%m-%d-%H-%M-%S-%L-${instance}.log.jsonl`,
                config: this.s3Config
            })
            return [new transports.Stream({ stream: s3AuditStream })]
        }

        return []
    }
}
