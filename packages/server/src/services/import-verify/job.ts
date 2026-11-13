import { createHash } from 'crypto'
import { applyCredential, connectionSlots, resolveSlot, type ConnectionResolution, type CredentialRow } from './connections'
import { missingRequired, planDiscovery, valuesFromDiscovery, type ParamSpec } from './discover'
import { inspectFlow, nodeById, relationsOf, type Blocker, type SmokeNeed } from './inspect'
import { parseFlow, queriesOnFlow, queryReady, replaceQuery, untrustImportedFlow, type SavedQuery } from './stamps'

export function hashFlow(flowText: string): string {
    return createHash('sha256').update(flowText).digest('hex')
}

export type QueryState = 'pending' | 'running' | 'passed' | 'empty' | 'failed'

export interface QueryProgress {
    nodeId: string
    pinId: string
    name: string
    title: string
    state: QueryState
    message: string
    attempts: number
    rowCount?: number
    statementHash?: string
}

export interface SmokeProgress {
    id: string
    label: string
    state: 'pending' | 'passed' | 'failed' | 'skipped'
    message: string
}

export interface VerifyRecord {
    version: 1
    draftHash: string
    status: 'running' | 'ready' | 'attention' | 'incomplete' | 'cancelled'
    phase: string
    checked: number
    total: number
    queries: QueryProgress[]
    connections: Array<{
        slotId: string
        nodeId: string
        nodeLabel: string
        expectedType: string
        status: ConnectionResolution['status']
        credentialId: string
        options: Array<{ id: string; name: string }>
    }>
    blockers: Blocker[]
    smoke: SmokeProgress[]
    summary: string
    publishOffered: boolean
    updatedAt: string
}

export interface TestPinResult {
    ok: boolean
    rowCount?: number
    entry?: SavedQuery
    statementHash?: string
    message?: string
    transient?: boolean
    cancelled?: boolean
}

export interface VerifyDeps {
    now: () => string
    saveFlow: (flowText: string) => Promise<string>
    saveRecord: (record: VerifyRecord) => Promise<void>
    credentials: () => Promise<CredentialRow[]>
    testPin: (input: {
        nodeId: string
        entry: SavedQuery
        sampleValues: Record<string, unknown>
        credentialId: string
    }) => Promise<TestPinResult>
    discover: (input: { node: Record<string, unknown>; sql: string }) => Promise<{ rows: Array<Record<string, unknown>> }>
    pdfAvailable: () => Promise<boolean>
    renderPdfSample: () => Promise<void>
    loadedNodeNames?: string[]
    pinnedQueriesEnabled: boolean
    concurrency?: number
    timeoutMs?: number
    signal?: AbortSignal
}

function paramsOf(pin: SavedQuery): ParamSpec[] {
    if (!Array.isArray(pin.params)) return []
    return pin.params.filter((item) => item && typeof item === 'object') as ParamSpec[]
}

function progressText(checked: number, total: number): string {
    if (!total) return 'Checking the flow.'
    return `Checking saved queries: ${checked} of ${total}.`
}

function publicConnections(list: ConnectionResolution[]): VerifyRecord['connections'] {
    return list.map((item) => ({
        slotId: item.slot.id,
        nodeId: item.slot.nodeId,
        nodeLabel: item.slot.nodeLabel,
        expectedType: item.slot.expectedType,
        status: item.status,
        credentialId: item.credentialId,
        options: item.options
    }))
}

export function finishRecord(record: VerifyRecord, now: string): VerifyRecord {
    const skippedFeature = record.blockers.some((item) => item.severity === 'incomplete')
    const cancelled = record.status === 'cancelled'
    const waiting = record.blockers.some((item) => item.action === 'choose-connection')
    const attention =
        waiting || record.blockers.some((item) => item.severity === 'attention') || record.queries.some((item) => item.state === 'failed')
    const pending = record.queries.some((item) => item.state === 'pending' || item.state === 'running')
    let status: VerifyRecord['status'] = 'ready'
    if (cancelled || skippedFeature) status = 'incomplete'
    else if (attention) status = 'attention'
    else if (pending) status = 'incomplete'
    const summary =
        status === 'ready'
            ? 'Ready to publish. Saved queries were tested on this server, and the checks for this flow passed. Nothing was published.'
            : status === 'attention'
            ? 'Needs attention. Fix the items below, then retry the ones that failed.'
            : 'Could not fully verify. The checks that did not run are listed below. Nothing was marked ready.'
    return {
        ...record,
        status,
        summary,
        publishOffered: status === 'ready',
        phase: status === 'ready' ? 'Finished' : record.phase,
        updatedAt: now
    }
}

export function importVerifyPublishBlock(raw: unknown, draftFlowData: string | null | undefined): string | null {
    if (!draftFlowData || raw == null || raw === '') return null
    let record: VerifyRecord | null = null
    try {
        record = typeof raw === 'string' ? (JSON.parse(raw) as VerifyRecord) : (raw as VerifyRecord)
    } catch {
        return null
    }
    if (!record || record.version !== 1 || record.draftHash !== hashFlow(draftFlowData)) return null
    if (record.status === 'ready') return null
    if (record.status === 'running') return 'Verification is still running. Publish stays available after it finishes.'
    if (record.status === 'attention') return 'This import needs attention. Open Import & verify, use the actions it shows, then publish.'
    return 'This import could not be fully verified. Resume it from Import & verify. Publish stays off until the required checks pass.'
}

function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(Object.assign(new Error('The query took too long.'), { transient: true }))
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(Object.assign(new Error('Verification was stopped.'), { cancelled: true }))
        }
        if (signal?.aborted) {
            onAbort()
            return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        work.then(
            (value) => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', onAbort)
                resolve(value)
            },
            (error) => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', onAbort)
                reject(error)
            }
        )
    })
}

function isTransient(error: unknown): boolean {
    const record = error as { transient?: boolean; message?: string }
    if (record?.transient) return true
    const message = String(record?.message || error || '')
    return /timeout|timed out|ECONNRESET|ECONNREFUSED|503|504|temporarily|connection terminated/i.test(message)
}

function draftMoved(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'draft-moved')
}

async function persist(
    deps: VerifyDeps,
    flow: unknown,
    record: VerifyRecord
): Promise<{ flowText: string; record: VerifyRecord; moved?: boolean }> {
    let stored: string
    try {
        stored = await deps.saveFlow(JSON.stringify(flow))
    } catch (error) {
        if (!draftMoved(error)) throw error
        const stopped = finishRecord(
            {
                ...record,
                status: 'incomplete',
                phase: 'The draft changed',
                blockers: [
                    ...record.blockers,
                    {
                        id: 'draft-moved',
                        severity: 'incomplete',
                        message:
                            'The draft changed while verification was running. The newer copy was left as it is. Resume to check that copy.',
                        action: 'none'
                    }
                ]
            },
            deps.now()
        )
        await deps.saveRecord(stopped)
        return { flowText: '', record: stopped, moved: true }
    }
    const next = { ...record, draftHash: hashFlow(stored), updatedAt: deps.now() }
    await deps.saveRecord(next)
    return { flowText: stored, record: next }
}

export async function executeVerify(options: {
    flowText: string
    record: VerifyRecord | null
    choices?: Record<string, string>
    retryFailures?: boolean
    deps: VerifyDeps
}): Promise<VerifyRecord> {
    const deps = options.deps
    const parsed = parseFlow(options.flowText)
    if (!parsed) {
        const empty = finishRecord(
            {
                version: 1,
                draftHash: hashFlow(options.flowText || ''),
                status: 'incomplete',
                phase: 'Could not read the file',
                checked: 0,
                total: 0,
                queries: [],
                connections: [],
                blockers: [
                    {
                        id: 'flow',
                        severity: 'incomplete',
                        message: 'That file is not a flow, so it could not be verified.',
                        action: 'none'
                    }
                ],
                smoke: [],
                summary: '',
                publishOffered: false,
                updatedAt: deps.now()
            },
            deps.now()
        )
        await deps.saveRecord(empty)
        return empty
    }

    const previous = options.record
    const keep = new Set(
        (previous?.queries || [])
            .filter((item) => item.state === 'passed' || item.state === 'empty')
            .map((item) => `${item.nodeId}\0${item.pinId}`)
    )
    let flow = untrustImportedFlow(parsed, keep).flow
    const credentials = await deps.credentials()
    const choices = options.choices || {}
    let resolutions = connectionSlots(flow).map((slot) => resolveSlot(slot, credentials, choices[slot.id]))
    for (const resolution of resolutions) {
        if (resolution.credentialId) flow = applyCredential(flow, resolution.slot.id, resolution.credentialId) as typeof flow
    }
    resolutions = connectionSlots(flow).map((slot) => {
        const choice = choices[slot.id]
        const resolved = resolveSlot(slot, credentials, choice)
        if (resolved.credentialId) return resolved
        return resolved
    })

    const listed = queriesOnFlow(flow)
    const prior = new Map((previous?.queries || []).map((item) => [`${item.nodeId}\0${item.pinId}`, item]))
    const queries: QueryProgress[] = listed.map(({ nodeId, pin }) => {
        const key = `${nodeId}\0${String(pin.id || '')}`
        const old = prior.get(key)
        let state: QueryState = 'pending'
        if (old && (old.state === 'passed' || old.state === 'empty') && queryReady(pin)) state = old.state
        else if (options.retryFailures && old?.state === 'failed') state = 'pending'
        return {
            nodeId,
            pinId: String(pin.id || ''),
            name: String(pin.name || ''),
            title: String(pin.purpose || pin.name || 'Saved query'),
            state,
            message: state === 'passed' || state === 'empty' ? old?.message || '' : '',
            attempts: state === 'pending' ? 0 : old?.attempts || 0,
            rowCount: old?.rowCount,
            statementHash: old?.statementHash
        }
    })

    let record: VerifyRecord = {
        version: 1,
        draftHash: '',
        status: 'running',
        phase: progressText(
            queries.filter((item) => item.state === 'passed' || item.state === 'empty' || item.state === 'failed').length,
            queries.length
        ),
        checked: queries.filter((item) => item.state !== 'pending' && item.state !== 'running').length,
        total: queries.length,
        queries,
        connections: publicConnections(resolutions),
        blockers: [],
        smoke: [],
        summary: '',
        publishOffered: false,
        updatedAt: deps.now()
    }
    let stored = await persist(deps, flow, record)
    if (stored.moved) return stored.record
    flow = parseFlow(stored.flowText) || flow
    record = stored.record

    const waitingConnection = resolutions.some((item) => {
        if (!item.slot.needed) return false
        return (
            item.status === 'missing' ||
            item.status === 'ambiguous' ||
            (item.status === 'empty' && item.slot.required && queries.some((query) => query.nodeId === item.slot.nodeId))
        )
    })
    if (waitingConnection) {
        const inspected = inspectFlow({
            flow,
            loadedNodeNames: deps.loadedNodeNames,
            pinnedQueriesEnabled: deps.pinnedQueriesEnabled,
            resolutions,
            statementHashes: {}
        })
        record = finishRecord(
            {
                ...record,
                blockers: inspected.blockers.filter((item) => item.action === 'choose-connection'),
                phase: 'Choose a connection'
            },
            deps.now()
        )
        await deps.saveRecord(record)
        return record
    }

    if (!deps.pinnedQueriesEnabled && record.queries.length) {
        const inspected = inspectFlow({
            flow,
            loadedNodeNames: deps.loadedNodeNames,
            pinnedQueriesEnabled: false,
            resolutions,
            statementHashes: {}
        })
        record = finishRecord({ ...record, blockers: inspected.blockers, phase: 'Saved queries are off' }, deps.now())
        await deps.saveRecord(record)
        return record
    }

    const concurrency = Math.max(1, Math.min(deps.concurrency ?? 4, 8))
    const timeoutMs = deps.timeoutMs ?? 20000
    const pending = record.queries.filter((item) => item.state === 'pending')

    for (let offset = 0; offset < pending.length; offset += concurrency) {
        if (deps.signal?.aborted) {
            record.status = 'cancelled'
            break
        }
        const slice = pending.slice(offset, offset + concurrency)
        await Promise.all(
            slice.map(async (query) => {
                if (deps.signal?.aborted) return
                query.state = 'running'
                const node = nodeById(flow, query.nodeId)
                const pin = queriesOnFlow(flow).find(
                    (item) => item.nodeId === query.nodeId && String(item.pin.id || '') === query.pinId
                )?.pin
                if (!pin || !node) {
                    query.state = 'failed'
                    query.message = 'The saved query is no longer on this draft.'
                    query.attempts += 1
                    return
                }
                const params = paramsOf(pin)
                const relations = relationsOf(node)
                let sample: Record<string, unknown> = {}
                const planned = planDiscovery(String(pin.sql || ''), relations)
                if ('text' in planned) {
                    try {
                        const found = await withTimeout(deps.discover({ node, sql: planned.text }), timeoutMs, deps.signal)
                        sample = valuesFromDiscovery(params, found.rows || [], planned.bindings)
                    } catch (error) {
                        const err = error as { cancelled?: boolean; message?: string }
                        if (err.cancelled || deps.signal?.aborted) {
                            query.state = 'pending'
                            query.message = 'Verification was stopped.'
                            return
                        }
                    }
                }
                sample = { ...valuesFromDiscovery(params, [], []), ...sample }
                const missing = missingRequired(params, sample)
                if (missing.length) {
                    query.state = 'failed'
                    query.attempts += 1
                    query.message = `Cuttlely could not choose test values for ${missing.join(
                        ', '
                    )}. The query was not run, and no sample values were requested.`
                    return
                }
                const credentialId = resolutions.find((item) => item.slot.nodeId === query.nodeId)?.credentialId || ''
                let result: TestPinResult | null = null
                let attempts = 0
                while (attempts < 3) {
                    if (deps.signal?.aborted) {
                        query.state = 'pending'
                        query.message = 'Verification was stopped.'
                        return
                    }
                    attempts += 1
                    try {
                        result = await withTimeout(
                            deps.testPin({ nodeId: query.nodeId, entry: pin, sampleValues: sample, credentialId }),
                            timeoutMs,
                            deps.signal
                        )
                    } catch (error) {
                        const err = error as { cancelled?: boolean; transient?: boolean; message?: string }
                        if (err.cancelled) {
                            query.state = 'pending'
                            query.message = 'Verification was stopped.'
                            return
                        }
                        result = { ok: false, message: err.message || 'The query could not be tested.', transient: isTransient(error) }
                    }
                    if (result?.ok || !result?.transient) break
                }
                query.attempts += attempts
                if (!result?.ok) {
                    query.state = 'failed'
                    query.message = result?.message || 'The query could not be tested.'
                    return
                }
                const rowCount = Number(result.rowCount || 0)
                query.rowCount = rowCount
                query.statementHash = result.statementHash
                query.state = rowCount > 0 ? 'passed' : 'empty'
                query.message =
                    rowCount > 0
                        ? 'Tested on this server.'
                        : 'The query ran and returned no rows. That is a valid run, and it is not proof that a report works.'
                if (result.entry) flow = replaceQuery(flow, query.nodeId, { ...result.entry, verifiedHere: true }) as typeof flow
            })
        )
        record.checked = record.queries.filter((item) => item.state !== 'pending' && item.state !== 'running').length
        record.phase = progressText(record.checked, record.total)
        record.queries = record.queries.map((item) => ({ ...item }))
        stored = await persist(deps, flow, record)
        if (stored.moved) return stored.record
        flow = parseFlow(stored.flowText) || flow
        record = { ...stored.record, queries: record.queries, checked: record.checked, phase: record.phase }
        if (deps.signal?.aborted) {
            record.status = 'cancelled'
            break
        }
    }

    const hashes: Record<string, string> = {}
    for (const query of record.queries) {
        if (query.statementHash) hashes[`${query.nodeId}\0${query.pinId}`] = query.statementHash
    }
    let pdfAvailable: boolean | undefined
    const mayNeedPdf = JSON.stringify(flow).includes('pdf')
    if (mayNeedPdf) {
        try {
            pdfAvailable = await deps.pdfAvailable()
        } catch {
            pdfAvailable = false
        }
    }
    const inspected = inspectFlow({
        flow,
        loadedNodeNames: deps.loadedNodeNames,
        pinnedQueriesEnabled: deps.pinnedQueriesEnabled,
        pdfAvailable,
        resolutions,
        statementHashes: hashes
    })
    const queryBlockers: Blocker[] = record.queries
        .filter((item) => item.state === 'failed')
        .map((item) => ({
            id: `query:${item.nodeId}:${item.pinId}`,
            severity: 'attention' as const,
            message: `${item.title}: ${item.message}`,
            action: 'retry' as const,
            nodeId: item.nodeId,
            pinId: item.pinId
        }))
    const smoke = await runSmoke(inspected.smoke, record.queries, pdfAvailable, deps)
    const smokeBlockers: Blocker[] = smoke
        .filter((item) => item.state === 'failed')
        .map((item) => ({
            id: `smoke:${item.id}`,
            severity: 'attention' as const,
            message: item.message,
            action: item.id === 'pdf' ? ('install-dependency' as const) : ('retry' as const)
        }))
    record = finishRecord(
        {
            ...record,
            blockers: [...inspected.blockers, ...queryBlockers, ...smokeBlockers],
            smoke,
            connections: publicConnections(resolutions)
        },
        deps.now()
    )
    await deps.saveRecord(record)
    return record
}

async function runSmoke(
    needs: SmokeNeed[],
    queries: QueryProgress[],
    pdfAvailable: boolean | undefined,
    deps: VerifyDeps
): Promise<SmokeProgress[]> {
    const byName = new Map(queries.map((item) => [item.name, item]))
    const out: SmokeProgress[] = []
    for (const need of needs) {
        if (need.id === 'analysis') {
            const failed = queries.some((item) => item.state === 'failed' || item.state === 'pending')
            const ran = queries.some((item) => item.state === 'passed' || item.state === 'empty')
            out.push({
                id: need.id,
                label: need.label,
                state: failed || !ran ? 'failed' : 'passed',
                message:
                    failed || !ran
                        ? 'Analysis was not fully checked because a saved query did not finish.'
                        : 'Saved queries ran on this server.'
            })
            continue
        }
        if (need.id === 'pdf') {
            if (pdfAvailable === false) {
                out.push({
                    id: need.id,
                    label: need.label,
                    state: 'failed',
                    message: 'PDF reports need the PDF library on this server. No file was written.'
                })
                continue
            }
            try {
                await deps.renderPdfSample()
                out.push({
                    id: need.id,
                    label: need.label,
                    state: 'passed',
                    message: 'A sample PDF was built in memory. No file was saved and nothing was sent outside this server.'
                })
            } catch {
                out.push({
                    id: need.id,
                    label: need.label,
                    state: 'failed',
                    message: 'The PDF library did not build a sample. No file was written.'
                })
            }
            continue
        }
        const related = need.pinNames.map((name) => byName.get(name)).filter(Boolean) as QueryProgress[]
        const empty = related.some((item) => item.state === 'empty')
        const failed = related.some((item) => item.state !== 'passed')
        if (empty || failed) {
            out.push({
                id: need.id,
                label: need.label,
                state: 'failed',
                message: empty
                    ? `${need.label} was not proven. A saved query ran and returned no rows, so the expected output was not checked.`
                    : `${need.label} was not proven because a saved query did not pass.`
            })
            continue
        }
        out.push({
            id: need.id,
            label: need.label,
            state: 'passed',
            message:
                need.id === 'csv'
                    ? 'The saved query returned rows, so the CSV contract has data to export. No file was written.'
                    : 'The saved query returned rows, so the report contract has data. No file was written.'
        })
    }
    return out
}
