import type { DataSource } from 'typeorm'

/** Workers pass their own connection. Web routes resolve the application only when handling a request. */
export async function accessData(dataSource?: DataSource): Promise<DataSource> {
    if (dataSource) return dataSource
    const { getRunningExpressApp } = await import('../../utils/getRunningExpressApp')
    return getRunningExpressApp().AppDataSource
}
