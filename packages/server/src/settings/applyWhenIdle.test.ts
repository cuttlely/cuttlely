import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyAdminSettings } from './apply'
import { IDLE_APPLY_FILE, startApplyWhenIdle } from './applyWhenIdle'
import { readHistory } from './history'
import { resetRestartRequest, setRestartHandler } from './restart'
import * as runs from './runs'
import { getView } from './service'
import { writeSettingsFile } from './store'

const KEY = 'test-key-not-a-real-secret-0123456789abcdef'
const RESTART = 'CUTTLELY_HARNESS_RUN_TIMEOUT_MS'
const LIVE = 'CUTTLELY_HARNESS_TURN_BUDGET_MS'
let data: string
let stop: (() => void) | undefined
const originalData = process.env.CUTTLELY_DATA_DIR
const originalKey = process.env.CUTTLELY_SECRETKEY_OVERWRITE

function fixture(supervised = true) {
    const env = { CUTTLELY_DATA_DIR: data, CUTTLELY_SECRETKEY_OVERWRITE: KEY, CUTTLELY_SUPERVISED: supervised ? '1' : '0' }
    const state = applyAdminSettings(env)
    const handler = jest.fn(async () => undefined)
    setRestartHandler(handler)
    stop = startApplyWhenIdle(env, state)
    const save = (values: Record<string, string>) => writeSettingsFile(state.dir, values, { key: KEY })
    return { env, state, handler, save, view: () => getView({ env, state, key: async () => KEY }) }
}

beforeEach(() => {
    jest.useFakeTimers()
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-idle-apply-'))
    process.env.CUTTLELY_DATA_DIR = data
    process.env.CUTTLELY_SECRETKEY_OVERWRITE = KEY
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    runs.resetRuns()
    resetRestartRequest()
})

afterEach(() => {
    stop?.()
    stop = undefined
    setRestartHandler(null)
    resetRestartRequest()
    runs.resetRuns()
    jest.restoreAllMocks()
    jest.useRealTimers()
    fs.rmSync(data, { recursive: true, force: true })
    if (originalData === undefined) delete process.env.CUTTLELY_DATA_DIR
    else process.env.CUTTLELY_DATA_DIR = originalData
    if (originalKey === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
    else process.env.CUTTLELY_SECRETKEY_OVERWRITE = originalKey
})

it('debounces pending limits, drains, requests one restart and writes key-only system history', async () => {
    const f = fixture()
    const drain = jest.spyOn(runs, 'drainRuns')
    const notifications = jest.fn()
    runs.onDrainStart(notifications)
    f.save({ [RESTART]: '300000' })
    expect((await f.view()).settings.find(({ key }) => key === RESTART)).toMatchObject({ changed: true, pending: 'idle' })
    await jest.advanceTimersByTimeAsync(5000)
    f.save({ [RESTART]: '360000' })
    await jest.advanceTimersByTimeAsync(9999)
    expect(f.handler).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(5002)
    expect(f.handler).toHaveBeenCalledTimes(1)
    expect(drain).toHaveBeenCalledWith(0, 250, { deferListeners: true })
    expect(runs.isDraining()).toBe(true)
    expect(notifications).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(30000)
    expect(f.handler).toHaveBeenCalledTimes(1)
    const history = readHistory(f.state.dir)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ kind: 'restart', by: 'system', event: 'settings.apply_when_idle', changes: [{ key: RESTART }] })
    const record = fs.readFileSync(path.join(f.state.dir, IDLE_APPLY_FILE), 'utf8')
    expect(record).toContain(RESTART)
    expect(record).not.toContain('360000')
    expect(JSON.stringify(history)).not.toContain('360000')
})

it('waits for a background async run that arrives during the debounce', async () => {
    const f = fixture()
    f.save({ [RESTART]: '300000' })
    await jest.advanceTimersByTimeAsync(9000)
    let finish = () => undefined
    const run = runs.trackBackgroundRun(new Promise<void>((resolve) => (finish = resolve)))
    await jest.advanceTimersByTimeAsync(11000)
    expect(f.handler).not.toHaveBeenCalled()
    expect(runs.isDraining()).toBe(false)
    finish()
    await run
    await jest.advanceTimersByTimeAsync(5001)
    expect(f.handler).toHaveBeenCalledTimes(1)
})

it('cancels an idle drain when an already admitted run becomes visible during the recheck', async () => {
    const f = fixture()
    let finish = () => undefined
    let run: Promise<void>
    const drain = runs.drainRuns
    const notifications = jest.fn()
    runs.onDrainStart(notifications)
    jest.spyOn(runs, 'drainRuns').mockImplementationOnce(async (...args) => {
        const result = await drain(...args)
        run = runs.trackBackgroundRun(new Promise<void>((resolve) => (finish = resolve)))
        return result
    })
    f.save({ [RESTART]: '300000' })
    await jest.advanceTimersByTimeAsync(10001)
    expect(f.handler).not.toHaveBeenCalled()
    expect(notifications).not.toHaveBeenCalled()
    expect(runs.isDraining()).toBe(false)
    expect(fs.existsSync(path.join(f.state.dir, IDLE_APPLY_FILE))).toBe(false)
    finish()
    await run!
    await jest.advanceTimersByTimeAsync(5001)
    expect(f.handler).toHaveBeenCalledTimes(1)
})

it.each([false, true])('requires supervision and a handler (supervised=%s)', async (supervised) => {
    const f = fixture(supervised)
    if (supervised) setRestartHandler(null)
    f.save({ [RESTART]: '300000' })
    await jest.advanceTimersByTimeAsync(30000)
    expect(f.handler).not.toHaveBeenCalled()
    expect((await f.view()).settings.find(({ key }) => key === RESTART)).toMatchObject({ changed: true, pending: 'restart' })
})

it('stops and flags the same pending set after another start, without exposing values', async () => {
    const f = fixture()
    f.save({ [RESTART]: '300000' })
    await jest.advanceTimersByTimeAsync(10001)
    expect(f.handler).toHaveBeenCalledTimes(1)
    stop!()
    runs.resetRuns()
    resetRestartRequest()
    // Simulate a start where the runtime still reports the previous in-effect snapshot.
    stop = startApplyWhenIdle(f.env, { ...f.state })
    await jest.advanceTimersByTimeAsync(30000)
    expect(f.handler).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(RESTART))
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('300000'))
    expect((await f.view()).settings.find(({ key }) => key === RESTART)).toMatchObject({ pending: 'restart', pendingBlocked: true })
})

it('never restarts for live limits or limits restored to their starting value', async () => {
    const f = fixture()
    f.save({ [LIVE]: '60000' })
    await jest.advanceTimersByTimeAsync(30000)
    f.save({ [RESTART]: '300000' })
    await jest.advanceTimersByTimeAsync(5000)
    f.save({ [RESTART]: '240000' })
    await jest.advanceTimersByTimeAsync(30000)
    expect(f.handler).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
    expect(readHistory(f.state.dir)).toHaveLength(0)
})

it('keeps a corrupt loop guard closed and removes it only after a start with no pending limits', async () => {
    const f = fixture()
    f.save({ [RESTART]: '300000' })
    fs.writeFileSync(path.join(f.state.dir, IDLE_APPLY_FILE), '{broken')
    await jest.advanceTimersByTimeAsync(20000)
    expect(f.handler).not.toHaveBeenCalled()
    expect((await f.view()).settings.find(({ key }) => key === RESTART)).toMatchObject({ pending: 'restart', pendingBlocked: true })
    stop!()
    stop = startApplyWhenIdle(f.env, applyAdminSettings(f.env))
    expect(fs.existsSync(path.join(f.state.dir, IDLE_APPLY_FILE))).toBe(false)
})

it('rechecks debounce and work again immediately before the restart handler', async () => {
    const f = fixture()
    f.save({ [RESTART]: '300000' })
    // Stop at the due check, after requestRestart has reserved its timer but before it calls the handler.
    await jest.advanceTimersByTimeAsync(10000)
    f.save({ [RESTART]: '360000' })
    await jest.advanceTimersByTimeAsync(1)
    expect(f.handler).not.toHaveBeenCalled()
    expect(runs.isDraining()).toBe(false)
    expect(readHistory(f.state.dir)).toHaveLength(0)
    await jest.advanceTimersByTimeAsync(15000)
    expect(f.handler).toHaveBeenCalledTimes(1)
})
