import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Readable } from 'node:stream'
import multer from 'multer'
import { LocalStorageProvider } from './LocalStorageProvider'
import { documentUploadMulterLimits } from './multerLimits'

// The server supplies a store bound to the selected application database.
export interface ApplicationFiles {
    put(segments: string[], data: Buffer | Readable): Promise<number>
    read(segments: string[]): Promise<Buffer>
    list(segments: string[]): Promise<Array<{ segments: string[]; size: number }>>
    size(segments: string[]): Promise<number>
    remove(segments: string[], recursive?: boolean): Promise<void>
}

export class PostgresStorageProvider extends LocalStorageProvider {
    constructor(private readonly files: ApplicationFiles) {
        super()
    }

    getStorageType() {
        return 'postgres'
    }

    private key(paths: string[]) {
        if (!paths.length || paths.some((part) => !part)) throw new Error('A scoped storage path is required.')
        return ['blobs', ...paths.map((part) => this.sanitizeFilename(part))]
    }

    private async usage(orgId: string) {
        return { totalSize: (await this.getStorageSize(orgId)) / (1024 * 1024) }
    }

    async addSingleFileToStorage(_mime: string, data: Buffer, fileName: string, ...paths: string[]) {
        const name = this.sanitizeFilename(fileName)
        await this.files.put([...this.key(paths), name], data)
        return { path: 'FILE-STORAGE::' + name, ...(await this.usage(paths[0])) }
    }
    async addArrayFilesToStorage(mime: string, data: Buffer, fileName: string, fileNames: string[], ...paths: string[]) {
        const result = await this.addSingleFileToStorage(mime, data, fileName, ...paths)
        fileNames.push(this.sanitizeFilename(fileName))
        return { ...result, path: 'FILE-STORAGE::' + JSON.stringify(fileNames) }
    }
    async addBase64FilesToStorage(value: string, flow: string, names: string[], org: string) {
        this.validateChatflowId(flow)
        const parts = value.split(',')
        const name = parts.pop()?.split(':')[1] || ''
        return this.addArrayFilesToStorage('', Buffer.from(parts.pop() || '', 'base64'), name, names, org, flow)
    }
    async getFileFromStorage(file: string, ...paths: string[]) {
        return this.files.read([...this.key(paths), this.sanitizeFilename(file)])
    }
    async streamStorageFile(flow: string, chat: string, name: string, org: string) {
        this.validateChatflowId(flow)
        this.validatePathSecurity(flow, chat)
        return this.getFileFromStorage(name, org, flow, chat)
    }
    async getFilesListFromStorage(...paths: string[]) {
        return (await this.files.list(this.key(paths))).map(({ segments, size }) => ({
            name: segments[segments.length - 1],
            path: segments.slice(1).join('/'),
            size
        }))
    }
    async getStorageSize(org: string) {
        return org ? this.files.size(this.key([org])) : 0
    }
    async removeSpecificFileFromStorage(...paths: string[]) {
        await this.files.remove(this.key(paths))
        return this.usage(paths[0])
    }
    async removeFilesFromStorage(...paths: string[]) {
        await this.files.remove(this.key(paths), true)
        return this.usage(paths[0])
    }
    async removeFolderFromStorage(...paths: string[]) {
        return this.removeFilesFromStorage(...paths)
    }

    private uploadKey(handle: string) {
        const prefix = 'cuttlely-upload/'
        if (handle.startsWith(prefix) && /^[a-f0-9-]{36}$/.test(handle.slice(prefix.length)))
            return ['uploads', handle.slice(prefix.length)]
        // Pre-upgrade multer references use a random filename under the configured upload directory.
        const root = process.env.BLOB_STORAGE_PATH
            ? path.join(process.env.BLOB_STORAGE_PATH, 'uploads')
            : path.join(this.storagePath, '..', 'uploads')
        if (path.dirname(handle) === path.resolve(root) && /^[a-f0-9]{32}$/.test(path.basename(handle)))
            return ['uploads', path.basename(handle)]
        throw new Error('Invalid upload reference.')
    }
    async getFileFromUpload(handle: string) {
        return this.files.read(this.uploadKey(handle))
    }
    async removeSpecificFileFromUpload(handle: string) {
        await this.files.remove(this.uploadKey(handle))
    }
    getMulterStorage(): multer.Multer {
        const storage: multer.StorageEngine = {
            _handleFile: (_req, file, done) => {
                const id = randomUUID()
                this.files.put(['uploads', id], file.stream).then((size) => done(null, { path: 'cuttlely-upload/' + id, size }), done)
            },
            _removeFile: (_req, file, done) => {
                this.removeSpecificFileFromUpload(file.path).then(() => done(null), done)
            }
        }
        return multer({ storage, limits: documentUploadMulterLimits() })
    }
}
