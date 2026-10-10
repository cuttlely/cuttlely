import { etlListError } from './etlError.mjs'

export const STATUS_COLORS = {
    queued: 'default',
    running: 'primary',
    pausing: 'warning',
    paused: 'warning',
    cancelling: 'warning',
    cancelled: 'default',
    failed: 'error',
    succeeded: 'success',
    // Some records were rejected; the run is still served (spec 5.3.3).
    partial: 'warning',
    // Rows written before the status rename, until the server migrates them.
    completed: 'success'
}

export const FINISHED_OK = new Set(['succeeded', 'partial', 'completed'])

export const ACTIVE = new Set(['queued', 'running', 'pausing', 'cancelling'])

export function formatNumber(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '–'
    return Number(n).toLocaleString()
}

export function formatBytes(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return `${n} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = n / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i += 1
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return '–'
    const s = Math.max(0, Math.round(seconds))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${s % 60}s`
    return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function runDuration(run) {
    if (!run?.startedAt) return null
    const end = run.finishedAt && !ACTIVE.has(run.status) ? new Date(run.finishedAt) : new Date()
    return (end - new Date(run.startedAt)) / 1000
}

export function timeAgo(iso) {
    if (!iso) return '–'
    const seconds = (Date.now() - new Date(iso).getTime()) / 1000
    if (seconds < 60) return 'just now'
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
    return new Date(iso).toLocaleDateString()
}

export function runProgress(run) {
    const c = run?.counters || {}
    if (FINISHED_OK.has(run?.status)) return 100
    if (c.bytesTotal > 0) return Math.min(100, (100 * c.bytesRead) / c.bytesTotal)
    if (c.unitsTotal > 0) return Math.min(100, (100 * c.unitsDone) / c.unitsTotal)
    return null
}

export function errorText(error) {
    const data = error?.response?.data
    if (data && typeof data === 'object' && typeof data.message === 'string' && data.message) return etlListError(data.message)
    if (typeof data === 'string' && data) return etlListError(data)
    return etlListError(error?.message || '')
}
