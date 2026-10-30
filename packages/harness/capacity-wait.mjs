// Admission retries are opt-in per specialist. Never retry an accepted run or a
// provider quota failure: either could already have performed work.
export const MAX_CAPACITY_WAIT_SECONDS = 60

export function specialistCapacityWaitSeconds(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return 0
    if (typeof value === 'string' && !value.trim()) return 0
    const seconds = Number(value)
    if (!Number.isFinite(seconds) || seconds <= 0) return 0
    return Math.min(MAX_CAPACITY_WAIT_SECONDS, Math.floor(seconds))
}

export function isRejectedCapacityAdmission(response, payload) {
    return (
        response?.status === 429 &&
        !payload?.run_id &&
        payload?.error?.code === 'rate_limit_exceeded' &&
        payload?.error?.type === 'rate_limit_error' &&
        typeof payload?.error?.message === 'string' &&
        /^Too many concurrent runs \(max [1-9][0-9]*\)$/.test(payload.error.message)
    )
}

export function capacityRetryDelayMs(response, attempt, now = Date.now()) {
    const raw = String(response?.headers?.get('retry-after') || '').trim()
    let retryAfterMs = 0
    if (raw.length <= 128 && /^[0-9]+(?:\.[0-9]+)?$/.test(raw)) {
        retryAfterMs = Math.ceil(Number(raw) * 1000)
    } else if (raw && raw.length <= 128) {
        const at = Date.parse(raw)
        if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - now)
    }
    // Back off even when a missing/zero Retry-After would otherwise spin. Never
    // shorten the server's requested delay to fit our local wait window.
    return Math.max(1000 * Math.min(5, 2 ** Math.min(Math.max(attempt - 1, 0), 3)), retryAfterMs)
}
