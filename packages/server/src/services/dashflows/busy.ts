// SQLITE_BUSY (and its extended codes) from node:sqlite: a Dash Flows write waited past busy_timeout,
// for example behind the boot-time copy of dashflows.sqlite into the application database.
export function dashFlowsBusy(error: unknown): boolean {
    const err = error as { code?: unknown; errcode?: unknown; message?: unknown } | null
    if (!err || typeof err !== 'object') return false
    if (typeof err.errcode === 'number' && (err.errcode & 0xff) === 5) return true
    return err.code === 'ERR_SQLITE_ERROR' && /database is locked/i.test(String(err.message))
}
