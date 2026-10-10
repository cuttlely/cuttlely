import { getErrorMessage } from '../../errors/utils'

// Keep the sentences in packages/ui/src/views/etl/etlError.mjs the same.
const SQLITE_BUILTIN = /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|No such built-in module/i

export const ETL_SQLITE_MESSAGE = 'ETL could not open its local database. Start Cuttlely with Node 24 and open this page again.'
export const ETL_LOAD_MESSAGE = 'ETL could not load this page. Restart Cuttlely and try again.'

export function userFacingError(error: unknown): string {
    const raw = getErrorMessage(error)
    if (SQLITE_BUILTIN.test(raw)) return ETL_SQLITE_MESSAGE
    if (/\n\s+at\s+/.test(raw) || raw.includes('node:internal/')) return ETL_LOAD_MESSAGE
    const line = raw.split('\n')[0].trim()
    return line || 'Something went wrong.'
}
