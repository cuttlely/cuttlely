import type { DataSource } from 'typeorm'

/** Routes load before the running application. Resolve it only when handling a request. */
export async function accessData(): Promise<DataSource> {
    const { getRunningExpressApp } = await import('../../utils/getRunningExpressApp')
    return getRunningExpressApp().AppDataSource
}
