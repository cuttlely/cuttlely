// An external worker must select the same stores as the web process before claiming a job.
import { createRequire } from 'node:module'

const server = createRequire(new URL('../server/package.json', import.meta.url))

export function loadWorkerSettings() {
    server('./dist/settings/bootstrap.js')
}

export async function startWorkerStorage() {
    if (process.env.DATABASE_TYPE?.toLowerCase() !== 'postgres') return
    const { getDataSource } = server('./dist/DataSource.js')
    const { verifyInstallationKey } = server('./dist/settings/keyGuard.js')
    const { registerAppCredentialSource } = server('./dist/utils/credentialSource.js')
    const { registerAppStoreSource, closeSideStores } = server('./dist/utils/appStoreSource.js')
    const { applicationFileStorage } = server('./dist/utils/index.js')
    const dataSource = getDataSource()
    await dataSource.initialize()
    const close = async () => {
        try {
            await closeSideStores()
        } finally {
            await dataSource.destroy()
        }
    }
    try {
        await verifyInstallationKey(dataSource, (message) => console.warn(message))
        await registerAppStoreSource(dataSource, console, undefined, { worker: true, ...applicationFileStorage() })
        await registerAppCredentialSource(dataSource)
        return close
    } catch (error) {
        await close()
        throw error
    }
}
