import { IStorageProvider } from './IStorageProvider'
import type { ApplicationFiles } from './PostgresStorageProvider'
import { LocalStorageProvider } from './LocalStorageProvider'

/**
 * Factory for creating and managing storage provider instances.
 * Uses singleton pattern to ensure only one provider instance exists.
 */
export class StorageProviderFactory {
    private static instance: IStorageProvider | null = null

    static setApplicationFiles(files: ApplicationFiles | null): void {
        if (process.env.STORAGE_TYPE && !['local', 'postgres'].includes(process.env.STORAGE_TYPE)) return
        if (!files) {
            StorageProviderFactory.instance = null
            return
        }
        const { PostgresStorageProvider } = require('./PostgresStorageProvider') as typeof import('./PostgresStorageProvider')
        StorageProviderFactory.instance = new PostgresStorageProvider(files)
    }

    static async probeApplicationFiles(): Promise<boolean> {
        const provider = StorageProviderFactory.instance
        if (!provider || !('probeStorage' in provider) || typeof provider.probeStorage !== 'function') return false
        await provider.probeStorage()
        return true
    }

    static async *readS3PredictionFile(segments: string[]) {
        const provider = StorageProviderFactory.getProvider()
        if (!('openPredictionFile' in provider) || typeof provider.openPredictionFile !== 'function')
            throw new Error('S3 storage is unavailable.')
        yield* await provider.openPredictionFile(segments)
    }

    // PostgreSQL stores application files. Its log transports still write ordinary process logs.
    static getProvider(forLogging = false): IStorageProvider {
        if (forLogging && process.env.STORAGE_TYPE === 'postgres') return new LocalStorageProvider()
        if (!StorageProviderFactory.instance) {
            const storageType = process.env.STORAGE_TYPE || 'local'

            switch (storageType) {
                case 's3':
                    StorageProviderFactory.instance = new (
                        require('./S3StorageProvider') as typeof import('./S3StorageProvider')
                    ).S3StorageProvider()
                    break
                case 'gcs':
                    StorageProviderFactory.instance = new (
                        require('./GCSStorageProvider') as typeof import('./GCSStorageProvider')
                    ).GCSStorageProvider()
                    break
                case 'azure':
                    StorageProviderFactory.instance = new (
                        require('./AzureBlobStorageProvider') as typeof import('./AzureBlobStorageProvider')
                    ).AzureBlobStorageProvider()
                    break
                case 'postgres':
                    throw new Error('PostgreSQL file storage requires a verified application database storage upgrade.')
                case 'local':
                    StorageProviderFactory.instance = new LocalStorageProvider()
                    break
                default:
                    throw new Error('Unsupported application file storage type.')
            }
        }
        return StorageProviderFactory.instance
    }
}
