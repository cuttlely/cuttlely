import { backoffDelay, isCancel, isNoResponse } from '@/api/resilience'
import { draftConflictFrom } from '@/utils/flowDrafts'

export const SAVE_RETRY_NOTICE = "Your changes aren't saved yet. We'll keep trying."
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

// Draft storage may add node-pack metadata. That metadata does not make the stored graph a different canvas.
export const sameSavedCanvas = (left, right) => {
    if (left === right) return true
    const a = parseCanvas(left)
    const b = parseCanvas(right)
    if (!a || !b) return false
    return JSON.stringify(withoutServerCanvasFields(a)) === JSON.stringify(withoutServerCanvasFields(b))
}

export const containsBase64Canvas = (flowData) => {
    const parsed = parseCanvas(flowData)
    if (!parsed) return false
    const file = /^data.*;base64/i
    for (const node of parsed.nodes) {
        if (node?.data?.category !== 'Document Loaders') continue
        for (const input of Object.values(node?.data?.inputs || {})) {
            if (typeof input !== 'string') continue
            if (file.test(input)) return true
            if (!input.startsWith('[')) continue
            try {
                if (JSON.parse(input).some((item) => typeof item === 'string' && file.test(item))) return true
            } catch {
                // This input is not a file list.
            }
        }
    }
    return false
}

const dateValue = (value) => {
    const result = Date.parse(value)
    return Number.isFinite(result) ? result : null
}

export const draftSaveLanded = (status, entry) => {
    const stored = status?.draft
    if (!stored) return sameSavedCanvas(entry.flowData, entry.liveFlowData)
    if (stored.hash === entry.expectedDraftHash || stored.updatedBy !== entry.userId) return false

    const updated = dateValue(stored.updatedDate)
    const baseUpdated = dateValue(entry.baseDraftUpdatedDate)
    const recent = updated !== null && updated >= entry.sentAt - SAVE_CLOCK_SKEW_MS
    const afterBase = updated !== null && baseUpdated !== null && updated > baseUpdated
    if (!recent && !afterBase) return false

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
    onResolved = () => undefined
}) => {
    let state = 'idle'
    let current = null
    let pending = null
    let stopped = false
    let reconnecting = false
    let generation = 0
    const timers = new Set()
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
            if (isNoResponse(error)) return { result: 'waiting' }
            throw error
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
        if (entry.sentAt === undefined) entry.sentAt = now()
        if (guarded) {
            const checked = await reconcileDraft(entry)
            if (checked.result === 'landed') return ackDraft(entry, checked.status, true)
            if (checked.result === 'conflict') return openDraftConflict(entry, null, checked.status)
            if (checked.result === 'waiting') return 'waiting'
        }

        for (let attempt = 0; attempt <= 3 && !stopped; attempt += 1) {
            if (attempt > 0) await waitForRetry(attempt)
            if (stopped) return 'done'
            try {
                const response = await putDraft(entry.id, entry.flowData, {
                    expectedDraftHash: entry.expectedDraftHash,
                    ...(entry.overwriteDraftChanges === true ? { overwriteDraftChanges: true } : {})
                })
                await ackDraft(entry, response?.data ?? response)
                return 'done'
            } catch (error) {
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
                if (checked.result === 'waiting') return 'waiting'
            }
        }
        return 'waiting'
    }

    const ackLive = async (entry, flow, reconciled = false) => {
        if (stopped) return
        await entry.onAck?.(flow, { reconciled })
        finishResolved(entry)
    }

    const readLive = async (entry) => {
        try {
            const response = await getLive(entry.id)
            return { result: 'read', stored: response?.data ?? response }
        } catch (error) {
            if (isNoResponse(error)) return { result: 'waiting' }
            throw error
        }
    }

    const runLive = async (entry, guarded) => {
        let retried = false
        if (!guarded && entry.beforeWrite && !entry.preflightDone) {
            try {
                const allowed = await entry.beforeWrite()
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
            if (checked.stored?.name === entry.body.name && sameSavedCanvas(checked.stored?.flowData, entry.body.flowData)) {
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
                if (stored?.name === entry.body.name && sameSavedCanvas(stored?.flowData, entry.body.flowData)) {
                    await ackLive(entry, stored, true)
                    return 'done'
                }
                if (stored?.updatedDate === entry.baseUpdatedDate) {
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

    const runCreate = async (entry) => {
        try {
            const response = await entry.send()
            await entry.onAck?.(response?.data ?? response)
            finishResolved(entry)
            return 'done'
        } catch (error) {
            if (isNoResponse(error) && !isCancel(error)) return 'waiting'
            throw error
        }
    }

    const settle = async (entry, result, runGeneration) => {
        if (stopped || generation !== runGeneration) return
        if (result === 'waiting') {
            stopReconnect()
            current = pending || entry
            pending = null
            state = 'waiting'
            onExhausted(current)
            return
        }
        current = null
        if (pending) {
            const next = pending
            pending = null
            state = 'saving'
            current = next
            await execute(next, false)
        } else {
            state = 'idle'
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
                    : await runCreate(entry)
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
        if (state === 'saving') {
            pending = captured
            return
        }
        if (state === 'waiting') {
            current = captured
            state = 'saving'
            execute(captured, captured.kind !== 'create')
            return
        }
        state = 'saving'
        current = captured
        execute(captured, false)
    }

    const retry = () => {
        if (stopped || state !== 'waiting' || !current || current.kind === 'create') return
        state = 'saving'
        execute(current, true)
    }

    const dispose = () => {
        stopped = true
        generation += 1
        state = 'stopped'
        current = null
        pending = null
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        stopReconnect()
    }

    return { enqueue, retry, dispose, getState: () => ({ state, current, pending }) }
}
