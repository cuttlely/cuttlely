import { backoffDelay, isCancel, isNoResponse } from '@/api/resilience'
import { draftConflictFrom } from '@/utils/flowDrafts'

export const SAVE_RETRY_NOTICE = "Your changes aren't saved yet. Choose Retry when the connection is back."
export const SAVE_AGAIN_NOTICE = 'The save did not get a response. Your edits are still here. Press Save again.'
export const CREATE_STATUS_NOTICE = 'The flow was created. We are still checking its save status.'
export const SAVE_CLOCK_SKEW_MS = 2 * 60 * 1000

const parseCanvas = (text) => {
    if (typeof text !== 'string' || !text) return null
    try {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) ? parsed : null
    } catch {
        return null
    }
}

const withoutServerCanvasFields = (canvas) => {
    const next = {
        ...canvas,
        nodes: canvas.nodes.map((node) => (node && Object.getPrototypeOf(node) === Object.prototype ? { ...node } : node))
    }
    for (const node of next.nodes) {
        if (!node?.data || Object.getPrototypeOf(node.data) !== Object.prototype) continue
        node.data = { ...node.data }
        delete node.data.nodePack
    }
    return next
}

const DATA_URL = /^data:[^;]+;base64,/i
const STORED_FILE = 'FILE-STORAGE::'

const savedFileName = (value) =>
    String(value || '')
        .split(/[\\/]/)
        .pop()
        .replace(/^draft-[0-9a-f]{8}-/i, '')

const dataFileName = (value) => {
    if (typeof value !== 'string' || !DATA_URL.test(value)) return null
    const match = value.match(/,filename:([^,]+)$/i)
    return match?.[1] ? savedFileName(match[1]) : null
}

const fileNamesInInput = (value) => {
    if (typeof value !== 'string' || !value) return null
    if (value.startsWith(STORED_FILE)) {
        const raw = value.slice(STORED_FILE.length)
        try {
            const parsed = JSON.parse(raw)
            const names = Array.isArray(parsed) ? parsed : [parsed]
            return names.length && names.every((name) => typeof name === 'string') ? names.map(savedFileName) : null
        } catch {
            return raw ? [savedFileName(raw)] : null
        }
    }
    const direct = dataFileName(value)
    if (direct) return [direct]
    if (!value.startsWith('[')) return null
    try {
        const parsed = JSON.parse(value)
        if (!Array.isArray(parsed) || !parsed.length) return null
        const names = parsed.map(dataFileName)
        return names.every(Boolean) ? names : null
    } catch {
        return null
    }
}

const withoutNestedFileBodies = (value) => {
    const names = fileNamesInInput(value)
    if (names) return { savedFileNames: names }
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
        try {
            const parsed = JSON.parse(value)
            const normalized = withoutNestedFileBodies(parsed)
            return normalized === parsed ? value : JSON.stringify(normalized)
        } catch {
            return value
        }
    }
    if (Array.isArray(value)) {
        let changed = false
        const normalized = value.map((item) => {
            const next = withoutNestedFileBodies(item)
            if (next !== item) changed = true
            return next
        })
        return changed ? normalized : value
    }
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        let changed = false
        const normalized = {}
        for (const [key, item] of Object.entries(value)) {
            const next = withoutNestedFileBodies(item)
            normalized[key] = next
            if (next !== item) changed = true
        }
        return changed ? normalized : value
    }
    return value
}

const withoutFileBodies = (canvas) => {
    const next = withoutServerCanvasFields(canvas)
    for (const node of next.nodes) {
        const inputs = node?.data?.inputs
        if (!inputs || Object.getPrototypeOf(inputs) !== Object.prototype) continue
        node.data.inputs = withoutNestedFileBodies(inputs)
    }
    return next
}

// Draft storage may add node-pack metadata. That metadata does not make the stored graph a different canvas.
export const sameSavedCanvas = (left, right) => {
    if (left === right) return true
    const a = parseCanvas(left)
    const b = parseCanvas(right)
    if (!a || !b) return false
    return JSON.stringify(withoutServerCanvasFields(a)) === JSON.stringify(withoutServerCanvasFields(b))
}

export const sameLiveCanvas = (left, right) => {
    if (sameSavedCanvas(left, right)) return true
    const a = parseCanvas(left)
    const b = parseCanvas(right)
    if (!a || !b) return false
    return JSON.stringify(withoutFileBodies(a)) === JSON.stringify(withoutFileBodies(b))
}

export const containsBase64Canvas = (flowData) => {
    const parsed = parseCanvas(flowData)
    if (!parsed) return false
    const containsDataUrl = (value) => {
        if (typeof value === 'string') {
            if (DATA_URL.test(value)) return true
            if (!value.startsWith('[') && !value.startsWith('{')) return false
            try {
                return containsDataUrl(JSON.parse(value))
            } catch {
                return false
            }
        }
        if (Array.isArray(value)) return value.some(containsDataUrl)
        if (value && typeof value === 'object') return Object.values(value).some(containsDataUrl)
        return false
    }
    for (const node of parsed.nodes) {
        if (containsDataUrl(node?.data?.inputs)) return true
    }
    return false
}

const dateValue = (value) => {
    const result = Date.parse(value)
    return Number.isFinite(result) ? result : null
}

export const draftSaveLanded = (status, entry) => {
    const stored = status?.draft
    if (!stored) return false
    if (stored.hash === entry.expectedDraftHash || stored.updatedBy !== entry.userId) return false

    const updated = dateValue(stored.updatedDate)
    const firstSent = entry.firstAttemptSentAt ?? entry.sentAt
    const lastSettled = entry.lastAttemptSettledAt
    // The two-minute allowance covers browser/server clock differences. Both bounds are required so
    // a later save from another tab cannot be mistaken for this attempt.
    if (
        updated === null ||
        !Number.isFinite(firstSent) ||
        !Number.isFinite(lastSettled) ||
        updated < firstSent - SAVE_CLOCK_SKEW_MS ||
        updated > lastSettled + SAVE_CLOCK_SKEW_MS
    )
        return false

    // Uploaded data is rewritten into stored paths, so its content cannot be compared reliably here.
    if (entry.hasBase64) return true
    return sameSavedCanvas(stored.flowData, entry.flowData)
}

export const draftBaseUnchanged = (status, entry) => {
    const storedHash = status?.draft?.hash ?? null
    return storedHash === (entry.expectedDraftHash ?? null)
}

const conflictFromStatus = (status) => ({
    savedBy: status?.draft?.updatedBy ? { id: status.draft.updatedBy } : null,
    savedAt: status?.draft?.updatedDate ?? null
})

const draftVersion = (status) => status?.draft?.hash ?? null

const withNextDraftBase = (entry, status) => ({
    ...entry,
    expectedDraftHash: draftVersion(status),
    baseDraftUpdatedDate: status?.draft?.updatedDate ?? null,
    baseFlowData: status?.draft?.flowData || entry.flowData
})

const withNextLiveBase = (entry, flow) => ({
    ...entry,
    baseUpdatedDate: flow?.updatedDate ?? entry.baseUpdatedDate,
    baseFlowData: flow?.flowData ?? entry.baseFlowData,
    baseName: flow?.name ?? entry.baseName
})

const liveCanvasMatch = (entry, stored) => {
    if (stored?.name !== entry.body.name) return 'none'
    if (sameSavedCanvas(stored?.flowData, entry.body.flowData)) return 'exact'
    return sameLiveCanvas(stored?.flowData, entry.body.flowData) ? 'files' : 'none'
}

const liveSaveLanded = (entry, stored) => {
    const match = liveCanvasMatch(entry, stored)
    return match === 'exact' || (match === 'files' && stored?.updatedDate !== entry.baseUpdatedDate)
}

export const createSaveQueue = ({
    putDraft,
    getDraftStatus,
    putLive,
    getLive,
    sleep,
    random = Math.random,
    now = Date.now,
    beginReconnect = () => undefined,
    endReconnect = () => undefined,
    onExhausted = () => undefined,
    onCreateStatusWaiting = () => undefined,
    onResolved = () => undefined,
    onBusyChange = () => undefined
}) => {
    let state = 'idle'
    let current = null
    let pending = null
    let continuations = []
    let createdFlow = null
    let stopped = false
    let reconnecting = false
    let generation = 0
    const timers = new Set()
    let busy = false
    const wait =
        sleep ||
        ((delay) =>
            new Promise((resolve) => {
                const timer = setTimeout(() => {
                    timers.delete(timer)
                    resolve()
                }, delay)
                timers.add(timer)
            }))

    const trackReconnect = () => {
        if (reconnecting) return
        reconnecting = true
        beginReconnect()
    }

    const setState = (next) => {
        state = next
        const nextBusy = next === 'saving' || (next === 'waiting' && current?.kind !== 'create')
        if (nextBusy === busy) return
        busy = nextBusy
        if (!stopped) onBusyChange(nextBusy)
    }

    const stopReconnect = () => {
        if (!reconnecting) return
        reconnecting = false
        endReconnect()
    }

    const finishResolved = (entry) => {
        stopReconnect()
        if (!stopped) onResolved(entry)
    }

    const ackDraft = async (entry, status, reconciled = false) => {
        if (stopped) return
        await entry.onAck?.(status, { reconciled, storedFlowData: status?.draft?.flowData || entry.flowData, hasBase64: entry.hasBase64 })
        if (pending?.kind === 'draft') pending = withNextDraftBase(pending, status)
        finishResolved(entry)
    }

    const openDraftConflict = async (entry, found, status) => {
        if (stopped) return
        await entry.onConflict?.(found || conflictFromStatus(status), status)
        finishResolved(entry)
    }

    const reconcileDraft = async (entry) => {
        let response
        try {
            response = await getDraftStatus(entry.id)
        } catch (error) {
            if (isCancel(error)) throw error
            return { result: 'waiting', readFailure: isNoResponse(error) ? 'no-response' : 'http' }
        }
        const status = response?.data ?? response
        if (draftSaveLanded(status, entry)) return { result: 'landed', status }
        if (!draftBaseUnchanged(status, entry)) return { result: 'conflict', status }
        return { result: 'unchanged', status }
    }

    const waitForRetry = async (attempt) => {
        trackReconnect()
        await wait(backoffDelay(attempt, random))
    }

    const runDraft = async (entry, guarded) => {
        if (guarded) {
            const checked = await reconcileDraft(entry)
            if (checked.result === 'landed') return ackDraft(entry, checked.status, true)
            if (checked.result === 'conflict') return openDraftConflict(entry, null, checked.status)
            if (checked.result === 'waiting') return 'waiting'
        }

        for (let attempt = 0; attempt <= 3 && !stopped; attempt += 1) {
            if (attempt > 0) await waitForRetry(attempt)
            if (stopped) return 'done'
            const attemptSentAt = now()
            const attemptTiming = { sentAt: attemptSentAt, settledAt: null }
            if (!Array.isArray(entry.attempts)) entry.attempts = []
            entry.attempts.push(attemptTiming)
            if (entry.firstAttemptSentAt === undefined) {
                entry.firstAttemptSentAt = attemptSentAt
                entry.sentAt = attemptSentAt
            }
            try {
                const response = await putDraft(entry.id, entry.flowData, {
                    expectedDraftHash: entry.expectedDraftHash,
                    ...(entry.overwriteDraftChanges === true ? { overwriteDraftChanges: true } : {})
                })
                attemptTiming.settledAt = now()
                entry.lastAttemptSettledAt = attemptTiming.settledAt
                await ackDraft(entry, response?.data ?? response)
                return 'done'
            } catch (error) {
                attemptTiming.settledAt = now()
                entry.lastAttemptSettledAt = attemptTiming.settledAt
                const conflict = draftConflictFrom(error)
                if (conflict) {
                    await openDraftConflict(entry, conflict)
                    return 'done'
                }
                if (!isNoResponse(error) || isCancel(error)) throw error
                trackReconnect()

                const checked = await reconcileDraft(entry)
                if (checked.result === 'landed') {
                    await ackDraft(entry, checked.status, true)
                    return 'done'
                }
                if (checked.result === 'conflict') {
                    await openDraftConflict(entry, null, checked.status)
                    return 'done'
                }
                if (checked.result === 'waiting' && (entry.hasBase64 || checked.readFailure !== 'no-response' || attempt === 3))
                    return 'waiting'
            }
        }
        return 'waiting'
    }

    const ackLive = async (entry, flow, reconciled = false) => {
        if (stopped) return
        await entry.onAck?.(flow, { reconciled })
        if (pending?.kind === 'live') pending = withNextLiveBase(pending, flow)
        finishResolved(entry)
    }

    const readLive = async (entry) => {
        try {
            const response = await getLive(entry.id)
            return { result: 'read', stored: response?.data ?? response }
        } catch (error) {
            if (isCancel(error)) throw error
            return { result: 'waiting' }
        }
    }

    const runLive = async (entry, guarded) => {
        let retried = false
        let guardedWriteUsed = false
        if (!guarded && entry.beforeWrite && !entry.preflightDone) {
            try {
                const allowed = await entry.beforeWrite(entry.baseUpdatedDate)
                entry.preflightDone = true
                if (!allowed) {
                    finishResolved(entry)
                    return 'done'
                }
            } catch (error) {
                if (!isNoResponse(error) || isCancel(error)) throw error
                trackReconnect()
                return 'waiting'
            }
        }
        if (guarded) {
            const checked = await readLive(entry)
            if (checked.result === 'waiting') return 'waiting'
            if (liveSaveLanded(entry, checked.stored)) {
                await ackLive(entry, checked.stored, true)
                return 'done'
            }
            if (checked.stored?.updatedDate !== entry.baseUpdatedDate) {
                await entry.onChanged?.(checked.stored)
                finishResolved(entry)
                return 'done'
            }
        }
        while (!stopped) {
            if (guarded && guardedWriteUsed) return 'waiting'
            if (guarded) guardedWriteUsed = true
            try {
                const response = await putLive(entry.id, entry.body)
                await ackLive(entry, response?.data ?? response)
                return 'done'
            } catch (error) {
                if (!isNoResponse(error) || isCancel(error)) throw error
                trackReconnect()
                const checked = await readLive(entry)
                if (checked.result === 'waiting') return 'waiting'
                const stored = checked.stored
                if (liveSaveLanded(entry, stored)) {
                    await ackLive(entry, stored, true)
                    return 'done'
                }
                if (stored?.updatedDate === entry.baseUpdatedDate) {
                    if (guarded) return 'waiting'
                    if (!retried) {
                        retried = true
                        continue
                    }
                    return 'waiting'
                }
                await entry.onChanged?.(stored)
                finishResolved(entry)
                return 'done'
            }
        }
        return 'done'
    }

    const saveAgainError = (error) => {
        const failure = new Error(SAVE_AGAIN_NOTICE)
        failure.cause = error
        failure.saveAgain = true
        return failure
    }

    const runNonReplay = async (entry) => {
        try {
            const response = await entry.send()
            const saved = response?.data ?? response
            if (entry.kind === 'create') return { result: 'done', created: saved }
            await entry.onAck?.(saved)
            if (pending?.kind === 'live') pending = withNextLiveBase(pending, saved)
            finishResolved(entry)
            return { result: 'done' }
        } catch (error) {
            if (isNoResponse(error) && !isCancel(error)) {
                await entry.onError?.(saveAgainError(error))
                finishResolved(entry)
                return { result: 'done', ambiguousCreate: entry.kind === 'create' }
            }
            throw error
        }
    }

    const createFollowup = async (entry, created) => {
        createdFlow = created
        let source = pending?.kind === 'create' ? pending : entry.createSource || entry
        if (source === pending) pending = null

        while (source) {
            let next = null
            for (let attempt = 0; attempt <= 3 && !stopped; attempt += 1) {
                if (attempt > 0) await waitForRetry(attempt)
                try {
                    next = source.afterCreate ? await source.afterCreate(created, { fromPending: source !== entry }) : null
                    break
                } catch (error) {
                    const canRetry =
                        (!isCancel(error) && (isNoResponse(error) || error?.createStatusReadFailed === true)) ||
                        error?.saveModeUnknown === true
                    if (canRetry && attempt < 3) continue
                    if (canRetry) {
                        entry.created = created
                        entry.createSource = source
                        trackReconnect()
                        return { result: 'waiting' }
                    }
                    await source.onError?.(error)
                    finishResolved(source)
                    return { result: 'done', dropPendingCreate: true }
                }
            }
            if (stopped) return { result: 'done' }

            if (pending?.kind === 'create') {
                source = pending
                pending = null
                continue
            }

            entry.createSource = null
            await entry.onAck?.(created, { willContinue: Boolean(next || pending) })
            finishResolved(entry)
            return { result: 'done', next }
        }
        return { result: 'done' }
    }

    const settle = async (entry, result, runGeneration) => {
        if (stopped || generation !== runGeneration) return
        const outcome = typeof result === 'string' ? { result } : result || { result: 'done' }
        if (outcome.ambiguousCreate && pending?.kind === 'create') pending = null
        if (outcome.dropPendingCreate && pending?.kind === 'create') pending = null
        if (outcome.result === 'waiting') {
            stopReconnect()
            current = entry
            setState('waiting')
            if (entry.kind === 'create') onCreateStatusWaiting(current)
            else onExhausted(current)
            return
        }
        current = null
        let next = outcome.next || null
        if (outcome.created) {
            const followed = await createFollowup(entry, outcome.created)
            if (followed.result === 'waiting') {
                stopReconnect()
                current = entry
                setState('waiting')
                if (entry.kind === 'create') onCreateStatusWaiting(current)
                else onExhausted(current)
                return
            }
            if (followed.dropPendingCreate && pending?.kind === 'create') pending = null
            next = followed.next || null
        }
        if (stopped || generation !== runGeneration) return
        if (!next && continuations.length) next = continuations.shift()
        if (!next && pending) {
            next = pending
            pending = null
        }
        if (next) {
            setState('saving')
            current = next
            await execute(next, false)
        } else {
            setState('idle')
        }
    }

    const execute = async (entry, guarded) => {
        const runGeneration = generation
        try {
            const result =
                entry.kind === 'draft'
                    ? await runDraft(entry, guarded)
                    : entry.kind === 'live'
                    ? await runLive(entry, guarded)
                    : entry.kind === 'create' && entry.created
                    ? { result: 'done', created: entry.created }
                    : await runNonReplay(entry)
            await settle(entry, result, runGeneration)
        } catch (error) {
            stopReconnect()
            if (!stopped) await entry.onError?.(error)
            if (!stopped) onResolved(entry)
            await settle(entry, 'done', runGeneration)
        }
    }

    const enqueue = (entry) => {
        if (stopped) return
        const captured = { ...entry, hasBase64: entry.hasBase64 ?? containsBase64Canvas(entry.flowData) }
        if (captured.kind === 'create' && createdFlow) captured.created = createdFlow
        if (state === 'saving') {
            if (captured.internal) continuations.push(captured)
            else pending = captured
            return
        }
        if (state === 'waiting') {
            if (captured.internal) continuations.push(captured)
            else pending = captured
            setState('saving')
            execute(current, true)
            return
        }
        setState('saving')
        current = captured
        execute(captured, false)
    }

    const retry = () => {
        if (stopped || state !== 'waiting' || !current || (current.kind === 'create' && !current.created)) return
        setState('saving')
        execute(current, true)
    }

    const dispose = () => {
        stopped = true
        generation += 1
        state = 'stopped'
        current = null
        pending = null
        continuations = []
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        stopReconnect()
    }

    return { enqueue, retry, dispose, getState: () => ({ state, current, pending }) }
}
