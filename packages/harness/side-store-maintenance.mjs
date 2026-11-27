let paused = false
let failure = null
export const storagePaused = () => paused
export function pauseStorage(value, reason = null) {
    paused = value
    failure = reason
}
export function assertStorageReady() {
    if (!paused) return
    throw Object.assign(new Error(failure?.message ?? 'Storage upgrade in progress. Try again in 30 seconds.'), {
        code: failure?.code ?? 'store_moving',
        status: 503,
        retryAfter: 30
    })
}

let jobs = new AbortController()
let running = 0
export const jobsStopped = () => jobs.signal.aborted
export const runningStorageJobs = () => running
export function stopJobs() {
    jobs.abort()
}
export function resumeJobs() {
    if (jobsStopped()) jobs = new AbortController()
}
export function assertJobsAllowed() {
    if (jobsStopped()) throw Object.assign(new Error('Jobs are paused for the storage upgrade.'), { code: 'aborted', status: 503 })
}
export async function trackStorageJob(work) {
    assertJobsAllowed()
    running++
    try {
        return await work(jobs.signal)
    } finally {
        running--
    }
}
