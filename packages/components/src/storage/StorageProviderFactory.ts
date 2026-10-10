import { IStorageProvider } from './IStorageProvider'
import { LocalStorageProvider } from './LocalStorageProvider'

/**
 * Factory for creating and managing storage provider instances.
 * Uses singleton pattern to ensure only one provider instance exists.
 */
export class StorageProviderFactory {
    private static instance: IStorageProvider | null = null

    /**
     * Get the storage provider instance based on STORAGE_TYPE environment variable.
     * Creates a new instance if one doesn't exist.
     */
    static getProvider(): IStorageProvider {
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
                case 'local':
                default:
                    StorageProviderFactory.instance = new LocalStorageProvider()
                    break
            }
        }
        return StorageProviderFactory.instance
    }
}
