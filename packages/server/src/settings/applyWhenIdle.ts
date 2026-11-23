// Restart-type limits apply through the supervised start script once work has finished.
// The durable attempt record contains keys and hashes only, so a failed application cannot cause a restart loop.
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { StartState } from './apply'
import { appendHistory } from './history'
import { limitSnapshot, resolveLimits } from './limits'
import { SETTINGS } from './registry'
import { requestRestart, restartInPlaceReady, restartRequested } from './restart'
import { cancelIdleDrain, drainRuns, isDraining, runsInProgress } from './runs'
import { onSettingsFileWritten, writeFileAtomic } from './store'

type Env = Record<string, string | undefined>
type Pending = { key: string; hash: string }[]
export const IDLE_APPLY_FILE = 'apply-when-idle.json'
const POLL_MS = 5000
const DEBOUNCE_MS = 10000
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const signature = (pending: Pending) => hash(JSON.stringify(pending))

export function pendingRestartLimits(env: Env, state: StartState): Pending {
    const current = limitSnapshot(env)
    const start =
        state.limitsAtStart ??
        Object.fromEntries([...resolveLimits(env, state.ignored ? {} : state.atStart)].map(([key, row]) => [key, row.value]))
    return SETTINGS.filter((setting) => setting.limit && setting.applies === 'restart' && !setting.fixed)
        .filter((setting) => current.get(setting.key)?.value !== start[setting.key])
        .map(({ key }) => ({ key, hash: hash(current.get(key)?.value ?? '') }))
        .sort((a, b) => a.key.localeCompare(b.key))
}

function readAttempts(dir: string): Record<string, Pending> {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, IDLE_APPLY_FILE), 'utf8'))
        if (!parsed || parsed.version !== 1 || typeof parsed.attempts !== 'object' || !parsed.attempts || Array.isArray(parsed.attempts))
            throw new Error()
        return parsed.attempts
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        // A damaged record cannot establish whether this set has already been attempted. Fail closed.
        throw new Error('Idle settings application record could not be read')
    }
}

export function idleApplyStatus(env: Env, state: StartState, pending = pendingRestartLimits(env, state)) {
    let blocked = false
    try {
        blocked = pending.length > 0 && Boolean(readAttempts(state.dir)[signature(pending)])
    } catch {
        blocked = pending.length > 0
    }
    return { pending: restartInPlaceReady(env) && !blocked ? ('idle' as const) : ('restart' as const), blocked }
}

let stopActive: (() => void) | undefined

/** Called once by the server, after it registers the restart handler. Returns a cleanup for tests and shutdown. */
export function startApplyWhenIdle(env: Env, state: StartState): () => void {
    if (stopActive) return stopActive
    let stopped = false
    let checking = false
    let timer: NodeJS.Timeout | undefined
    let lastSave = Date.now()
    const attempted = new Set<string>()
    const warned = new Set<string>()
    const warn = (pending: Pending) => {
        const id = signature(pending)
        if (warned.has(id)) return
        warned.add(id)
        console.warn(
            `[server]: Settings still pending after idle application; restart manually: ${pending.map(({ key }) => key).join(', ')}`
        )
    }
    const schedule = () => {
        if (!stopped && !timer) {
            timer = setTimeout(() => {
                timer = undefined
                void check()
            }, POLL_MS)
            timer.unref()
        }
    }
    const check = async () => {
        if (stopped || checking || restartRequested()) return
        checking = true
        let pending: Pending = []
        try {
            pending = pendingRestartLimits(env, state)
            if (!pending.length) return
            const id = signature(pending)
            const attempts = readAttempts(state.dir)
            if (attempted.has(id) || attempts[id]) {
                warn(pending)
                return
            }
            schedule()
            if (!restartInPlaceReady(env) || isDraining() || Date.now() - lastSave < DEBOUNCE_MS || runsInProgress() !== 0) return
            const savedAt = lastSave
            // Admission stops synchronously. Defer drain listeners until the second check, since some stop schedulers.
            await drainRuns(0, 250, { deferListeners: true })
            if (
                stopped ||
                restartRequested() ||
                !restartInPlaceReady(env) ||
                lastSave !== savedAt ||
                runsInProgress() !== 0 ||
                signature(pendingRestartLimits(env, state)) !== id
            ) {
                cancelIdleDrain()
                return
            }
            const restarting = requestRestart({
                env,
                delayMs: 0,
                canRestart: () => {
                    try {
                        // A save or an admitted background run may arrive before the restart timer fires.
                        if (
                            stopped ||
                            Date.now() - lastSave < DEBOUNCE_MS ||
                            runsInProgress() !== 0 ||
                            signature(pendingRestartLimits(env, state)) !== id
                        ) {
                            cancelIdleDrain()
                            return false
                        }
                        writeFileAtomic(
                            state.dir,
                            IDLE_APPLY_FILE,
                            JSON.stringify({ version: 1, attempts: { ...attempts, [id]: pending } }) + '\n'
                        )
                        attempted.add(id)
                        appendHistory(state.dir, {
                            kind: 'restart',
                            by: 'system',
                            event: 'settings.apply_when_idle',
                            outcome: 'ok',
                            note: 'Restarting while idle to apply saved limits.',
                            changes: pending.map(({ key }) => ({ key }))
                        })
                        return true
                    } catch {
                        cancelIdleDrain()
                        warn(pending)
                        return false
                    }
                },
                before: () => drainRuns(0)
            })
            if (!restarting) cancelIdleDrain()
        } catch {
            cancelIdleDrain()
            if (pending.length) warn(pending)
        } finally {
            checking = false
        }
    }
    const unsubscribe = onSettingsFileWritten((dir) => {
        if (dir !== state.dir) return
        lastSave = Date.now()
        void check()
    })
    const stop = () => {
        stopped = true
        if (timer) clearTimeout(timer)
        unsubscribe()
        if (stopActive === stop) stopActive = undefined
    }
    stopActive = stop
    // No pending limits at a successful start means the previous attempt applied. Retire its loop guard.
    if (!pendingRestartLimits(env, state).length) {
        try {
            fs.rmSync(path.join(state.dir, IDLE_APPLY_FILE), { force: true })
        } catch {
            /* A later read fails closed. */
        }
    }
    void check()
    return stop
}
