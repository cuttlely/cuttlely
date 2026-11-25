let paused = false
export const storagePaused = () => paused
export function pauseStorage(value) {
    paused = value
}
export function assertStorageReady() {
    if (!paused) return
    throw Object.assign(new Error('Storage upgrade in progress. Try again in 30 seconds.'), {
        code: 'store_moving',
        status: 503,
        retryAfter: 30
    })
}
