/**
 * Harness delete: the card delete, the cascade from a canvas delete, the orphan cleanup at startup, and the orphan flag.
 * Harness modules are in-memory stand-ins; every name and id is made up.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

jest.mock('./apiAccess', () => ({
    ...jest.requireActual('./apiAccess'),
    removeHarnessFromKeyLists: jest.fn(async () => 0)
}))

import harnessesService, {
    resetNameLocks,
    harnessCanvasLookup,
    harnessDeleteHooks,
    removeHarnessesForCanvas,
    setHarnessModuleLoader
} from './index'
import { removeHarnessFromKeyLists } from './apiAccess'

const TEAM = 'team-a'
const CANVAS_NAVI = '11111111-1111-4111-8111-111111111111'
const CANVAS_GONE = '22222222-2222-4222-8222-222222222222'

type Row = { name: string; chatflowId?: string; workspaceId?: string; specialists: unknown[] }
let runRows: Array<{ table: string; harness: string }>
let schedules: Set<string>
let canvases: Map<string, { workspaceId: string; type: string } | 'fail'>
let storeDir: string
let failRuns = false
let cleaned: string[]
let failCleanup = false
let reopened: string[] = []
let duringCleanup: ((name: string) => Promise<void>) | null = null
let keptProfiles: string[] = []

const fileOf = (name: string) => path.join(storeDir, `${name}.json`)
const has = (name: string) => fs.existsSync(fileOf(name))
const write = (row: Row) => fs.writeFileSync(fileOf(row.name), JSON.stringify(row))

const fakeModules = (file: string) => {
    if (file === 'store.mjs') {
        return Promise.resolve({
            listHarnesses: () =>
                fs
                    .readdirSync(storeDir)
                    .filter((entry) => entry.endsWith('.json'))
                    .map((entry) => JSON.parse(fs.readFileSync(path.join(storeDir, entry), 'utf8'))),
            getHarness: (name: string) => (has(name) ? JSON.parse(fs.readFileSync(fileOf(name), 'utf8')) : null),
            deleteHarness: (name: string) => fs.rmSync(fileOf(name), { force: true }),
            claimWorkspace: (name: string) => JSON.parse(fs.readFileSync(fileOf(name), 'utf8'))
        })
    }
    if (file === 'cleanup.mjs') {
        return Promise.resolve({
            deleteHarnessAndProfiles: async (name: string) => {
                if (failCleanup) throw new Error('revoke failed')
                cleaned.push(name)
                fs.rmSync(fileOf(name), { force: true })
                if (duringCleanup) await duringCleanup(name)
            },
            reopenHarness: (name: string) => reopened.push(name),
            revokeHarness: (name: string) => {
                if (failCleanup) throw new Error(`revoke failed for ${name}`)
            },
            removeHarnessProfiles: async (name: string) => {
                if (duringCleanup) await duringCleanup(name)
                cleaned.push(name)
                return { removed: [], kept: keptProfiles, error: null }
            },
            sweepOrphanHarnessProfiles: async () => ({ mode: 'log', orphans: [], removed: [], skipped: [] })
        })
    }
    if (file === 'schedule.mjs') return Promise.resolve({ deleteSchedule: (name: string) => schedules.delete(name) })
    if (file === 'paths.mjs') return Promise.resolve({ harnessStoreDir: () => storeDir })
    if (file === 'lock.mjs') {
        return Promise.resolve({
            immediate: (fn: (db: unknown) => void) => {
                if (failRuns) throw new Error('harness database locked')
                return fn({
                    prepare: (sql: string) => ({
                        all: () => [{ name: 'run_history' }, { name: 'run_results' }],
                        run: (name: string) => {
                            const table = /FROM (\w+)/.exec(sql)?.[1]
                            runRows = runRows.filter((row) => !(row.table === table && row.harness === name))
                        }
                    })
                })
            }
        })
    }
    return Promise.reject(new Error(`unexpected module ${file}`))
}

const originalHooks = { ...harnessDeleteHooks }
const originalFind = harnessCanvasLookup.find

beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-delete-'))
    failRuns = false
    cleaned = []
    reopened = []
    failCleanup = false
    duringCleanup = null
    keptProfiles = []
    write({ name: 'navi', chatflowId: CANVAS_NAVI, workspaceId: TEAM, specialists: [{ name: 'scout' }] })
    write({ name: 'NAVI-B', workspaceId: TEAM, specialists: [{ name: 'scout' }, { name: 'writer' }] })
    write({ name: 'navi-harness', chatflowId: CANVAS_GONE, workspaceId: TEAM, specialists: [{ name: 'scout' }] })
    runRows = ['navi', 'NAVI-B', 'navi-harness'].flatMap((harness) => [
        { table: 'run_history', harness },
        { table: 'run_results', harness }
    ])
    schedules = new Set(['navi', 'navi-harness'])
    canvases = new Map([[CANVAS_NAVI, { workspaceId: TEAM, type: 'HARNESS' }]])
    setHarnessModuleLoader(fakeModules)
    harnessCanvasLookup.find = async (id: string) => {
        const row = canvases.get(id)
        if (row === 'fail') return { state: 'unknown' }
        return row ? { state: 'present', ...row } : { state: 'missing' }
    }
    // Stands in for the chat flow delete: the canvas row goes, and the cascade runs inside the same step.
    harnessDeleteHooks.deleteCanvas = jest.fn(async (chatflowId: string, workspaceId: string) => {
        canvases.delete(chatflowId)
        const cascade = await removeHarnessesForCanvas(chatflowId, workspaceId)
        await cascade.commit()
    })
    ;(removeHarnessFromKeyLists as jest.Mock).mockClear()
})

afterEach(() => {
    resetNameLocks()
    setHarnessModuleLoader(null)
    Object.assign(harnessDeleteHooks, originalHooks)
    harnessCanvasLookup.find = originalFind
    fs.rmSync(storeDir, { recursive: true, force: true })
})

describe('card delete', () => {
    it('removes the canvas, the record, its schedule, key grants and runs', async () => {
        await expect(harnessesService.deleteHarness('navi', TEAM)).resolves.toEqual({ name: 'navi', deleted: true })
        expect(harnessDeleteHooks.deleteCanvas).toHaveBeenCalledWith(CANVAS_NAVI, TEAM)
        expect(canvases.has(CANVAS_NAVI)).toBe(false)
        expect(has('navi')).toBe(false)
        expect(schedules.has('navi')).toBe(false)
        expect(removeHarnessFromKeyLists).toHaveBeenCalledWith(TEAM, 'navi', undefined)
        expect(runRows.some((row) => row.harness === 'navi')).toBe(false)
        expect(runRows.filter((row) => row.harness === 'NAVI-B')).toHaveLength(2)
    })

    it('removes the runtime profiles of exactly that harness', async () => {
        await harnessesService.deleteHarness('navi', TEAM)
        expect(cleaned).toEqual(['navi'])
        expect(has('navi-harness')).toBe(true)
    })

    it('lets a harness register tokens again when its delete stops after revocation', async () => {
        ;(removeHarnessFromKeyLists as jest.Mock).mockRejectedValueOnce(new Error('api key table locked'))
        await expect(harnessesService.deleteHarness('NAVI-B', TEAM)).rejects.toMatchObject({ statusCode: 500 })
        expect(has('NAVI-B')).toBe(true)
        expect(reopened).toEqual(['NAVI-B'])
    })

    it('keeps the harness when its gateway tokens cannot be revoked', async () => {
        failCleanup = true
        ;(removeHarnessFromKeyLists as jest.Mock).mockClear()
        schedules.add('NAVI-B')
        await expect(harnessesService.deleteHarness('NAVI-B', TEAM)).rejects.toMatchObject({ statusCode: 500 })
        expect(has('NAVI-B')).toBe(true)
        expect(removeHarnessFromKeyLists).not.toHaveBeenCalled()
        expect(schedules.has('NAVI-B')).toBe(true)
        expect(runRows.filter((row) => row.harness === 'NAVI-B').length).toBeGreaterThan(0)
    })

    it('removes a harness with no canvas directly', async () => {
        await harnessesService.deleteHarness('NAVI-B', TEAM)
        expect(harnessDeleteHooks.deleteCanvas).not.toHaveBeenCalled()
        expect(has('NAVI-B')).toBe(false)
    })

    it('deletes an orphan card', async () => {
        await harnessesService.deleteHarness('navi-harness', TEAM)
        expect(has('navi-harness')).toBe(false)
    })

    it('keeps the harness when the canvas cannot be read', async () => {
        canvases.set(CANVAS_NAVI, 'fail')
        await expect(harnessesService.deleteHarness('navi', TEAM)).rejects.toMatchObject({ statusCode: 503 })
        expect(has('navi')).toBe(true)
    })

    it('is a 404 for another team', async () => {
        await expect(harnessesService.deleteHarness('navi', 'team-b')).rejects.toMatchObject({ statusCode: 404 })
        expect(has('navi')).toBe(true)
    })
})

describe('canvas delete cascade', () => {
    const manager = { name: 'the canvas transaction' } as any

    it('removes key grants in the canvas transaction and stages the record until the commit', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, manager)
        expect(cascade.names).toEqual(['navi'])
        expect(removeHarnessFromKeyLists).toHaveBeenCalledWith(TEAM, 'navi', manager)
        expect(has('navi')).toBe(false)
        expect(fs.existsSync(path.join(storeDir, 'navi.json.deleting'))).toBe(true)
        // Nothing outside the transaction is gone before the commit.
        expect(schedules.has('navi')).toBe(true)
        await cascade.commit()
        expect(fs.existsSync(path.join(storeDir, 'navi.json.deleting'))).toBe(false)
        expect(schedules.has('navi')).toBe(false)
        expect(runRows.some((row) => row.harness === 'navi')).toBe(false)
        expect(has('NAVI-B')).toBe(true)
    })

    it('refuses the canvas delete before touching grants or records when revocation fails', async () => {
        failCleanup = true
        ;(removeHarnessFromKeyLists as jest.Mock).mockClear()
        await expect(removeHarnessesForCanvas(CANVAS_NAVI, TEAM, manager)).rejects.toMatchObject({ statusCode: 500 })
        expect(removeHarnessFromKeyLists).not.toHaveBeenCalled()
        expect(has('navi')).toBe(true)
        expect(schedules.has('navi')).toBe(true)
    })

    it('keeps the staged record and every profile when revocation fails at commit', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, manager)
        failCleanup = true
        await cascade.commit()
        expect(fs.existsSync(path.join(storeDir, 'navi.json.deleting'))).toBe(true)
        expect(cleaned).toEqual([])
        expect(schedules.has('navi')).toBe(true)
        expect(runRows.some((row) => row.harness === 'navi')).toBe(true)
    })

    it('restore puts the record back when the transaction fails, with its schedule and runs untouched', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, manager)
        await cascade.restore()
        expect(JSON.parse(fs.readFileSync(fileOf('navi'), 'utf8'))).toMatchObject({
            name: 'navi',
            chatflowId: CANVAS_NAVI,
            workspaceId: TEAM
        })
        expect(schedules.has('navi')).toBe(true)
        expect(runRows.filter((row) => row.harness === 'navi')).toHaveLength(2)
    })

    it('throws and keeps the record when the key lists cannot be changed, so the transaction rolls back', async () => {
        ;(removeHarnessFromKeyLists as jest.Mock).mockRejectedValueOnce(new Error('api key table locked'))
        await expect(removeHarnessesForCanvas(CANVAS_NAVI, TEAM, manager)).rejects.toThrow(/api key table locked/)
        expect(has('navi')).toBe(true)
    })

    it('leaves a record in another team alone', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, 'team-b', manager)
        expect(cascade.names).toEqual([])
        expect(has('navi')).toBe(true)
    })

    it('a process that stopped mid-delete is settled at start: restored with its canvas, finished without it', async () => {
        await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, manager)
        resetNameLocks() // the process stopped
        await harnessesService.removeOrphanHarnesses()
        expect(has('navi')).toBe(true)

        await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, manager)
        resetNameLocks()
        canvases.delete(CANVAS_NAVI)
        const result = await harnessesService.removeOrphanHarnesses()
        expect(result.removed).toContain('navi')
        expect(has('navi')).toBe(false)
        expect(fs.existsSync(path.join(storeDir, 'navi.json.deleting'))).toBe(false)
        expect(schedules.has('navi')).toBe(false)
    })
})

describe('a reused name never sees an earlier harness data', () => {
    it('clears run rows and a schedule left under a new name before a canvas claims it', async () => {
        runRows.push({ table: 'run_history', harness: 'navi-c' }, { table: 'run_results', harness: 'navi-c' })
        schedules.add('navi-c')
        await harnessesService.assertNameAvailable('navi-c', 'team-b', { claiming: true })
        expect(runRows.some((row) => row.harness === 'navi-c')).toBe(false)
        expect(schedules.has('navi-c')).toBe(false)
    })

    it('refuses the save when the leftovers cannot be cleared', async () => {
        runRows.push({ table: 'run_history', harness: 'navi-c' })
        failRuns = true
        await expect(harnessesService.assertNameAvailable('navi-c', 'team-b', { claiming: true })).rejects.toMatchObject({
            statusCode: 503
        })
    })

    it('a staged delete reserves its name until the transaction ends', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, { name: 'tx' } as any)
        await expect(harnessesService.assertNameAvailable('navi', 'team-b', { claiming: true })).rejects.toMatchObject({ statusCode: 409 })
        expect(schedules.has('navi')).toBe(true)
        expect(runRows.filter((row) => row.harness === 'navi')).toHaveLength(2)
        await cascade.restore()
        expect(has('navi')).toBe(true)
    })

    it('a canvas sync of the name waits for the pending delete, then sees the restored record', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, { name: 'tx' } as any)
        const seen: string[] = []
        const sync = harnessesService.withNameLock('navi', async () => {
            seen.push(has('navi') ? 'record' : fs.existsSync(path.join(storeDir, 'navi.json.deleting')) ? 'staged' : 'none')
            await harnessesService.assertNameAvailable('navi', TEAM)
        })
        await new Promise((resolve) => setImmediate(resolve))
        expect(seen).toEqual([])
        await cascade.restore()
        await sync
        expect(seen).toEqual(['record'])
    })

    it('a canvas sync of the name waits until the commit cleanup has finished', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, { name: 'tx' } as any)
        const order: string[] = []
        let sync: Promise<void> | undefined
        duringCleanup = async () => {
            sync = harnessesService.withNameLock('navi', async () => {
                order.push('sync')
            })
            await new Promise((resolve) => setImmediate(resolve))
            order.push('profiles')
        }
        await cascade.commit()
        order.push('commit done')
        await sync
        expect(order).toEqual(['profiles', 'commit done', 'sync'])
        expect(schedules.has('navi')).toBe(false)
    })

    it('a record saved while the runtime shuts down keeps its schedule and runs', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, { name: 'tx' } as any)
        duringCleanup = async () => {
            write({ name: 'navi', workspaceId: TEAM, specialists: [{ name: 'other' }] })
        }
        await cascade.commit()
        expect(has('navi')).toBe(true)
        expect(schedules.has('navi')).toBe(true)
        expect(runRows.filter((row) => row.harness === 'navi')).toHaveLength(2)
    })

    it('a card delete leaves a replacement saved while the cascade cleaned up', async () => {
        duringCleanup = async () => {
            write({ name: 'navi', workspaceId: 'team-b', specialists: [{ name: 'other' }] })
            runRows.push({ table: 'run_history', harness: 'navi' })
        }
        await harnessesService.deleteHarness('navi', TEAM)
        expect(JSON.parse(fs.readFileSync(fileOf('navi'), 'utf8'))).toMatchObject({ workspaceId: 'team-b' })
        expect(runRows.some((row) => row.harness === 'navi')).toBe(true)
    })

    it('a direct delete keeps the runs of a record saved while the runtime shut down', async () => {
        duringCleanup = async () => {
            write({ name: 'NAVI-B', workspaceId: TEAM, specialists: [{ name: 'other' }] })
        }
        await harnessesService.deleteHarness('NAVI-B', TEAM)
        expect(has('NAVI-B')).toBe(true)
        expect(runRows.filter((row) => row.harness === 'NAVI-B')).toHaveLength(2)
    })

    it('a direct delete holds the name lock until its cleanup is done', async () => {
        const order: string[] = []
        let sync: Promise<void> | undefined
        duringCleanup = async () => {
            sync = harnessesService.withNameLock('NAVI-B', async () => {
                order.push('sync')
            })
            await new Promise((resolve) => setImmediate(resolve))
            order.push('cleanup')
        }
        await harnessesService.deleteHarness('NAVI-B', TEAM)
        order.push('delete done')
        await sync
        expect(order).toEqual(['cleanup', 'delete done', 'sync'])
    })

    it('refuses a new harness under a name whose old profiles could not be removed', async () => {
        keptProfiles = ['fresh-name--a']
        await expect(harnessesService.assertNameAvailable('fresh-name', TEAM, { claiming: true })).rejects.toMatchObject({
            statusCode: 503
        })
        keptProfiles = []
        await harnessesService.assertNameAvailable('fresh-name', TEAM, { claiming: true })
        expect(cleaned).toEqual(['fresh-name', 'fresh-name'])
    })

    it('a sync that reaches the name check while a delete is staged is refused', async () => {
        await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, { name: 'tx' } as any)
        // A restart drops the in-process lock: the staged file alone still holds the name.
        resetNameLocks()
        await expect(harnessesService.assertNameAvailable('navi', TEAM)).rejects.toMatchObject({ statusCode: 409 })
    })

    it('restore never replaces a record saved under the name since', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM, { name: 'tx' } as any)
        write({ name: 'navi', workspaceId: 'team-b', specialists: [{ name: 'other' }] })
        await cascade.restore()
        expect(JSON.parse(fs.readFileSync(fileOf('navi'), 'utf8'))).toMatchObject({ workspaceId: 'team-b' })
        expect(fs.existsSync(path.join(storeDir, 'navi.json.deleting'))).toBe(false)
    })

    it('a canvas that only names a harness does not clear anything', async () => {
        runRows.push({ table: 'run_history', harness: 'navi-c' })
        await harnessesService.assertNameAvailable('navi-c', 'team-b')
        expect(runRows.some((row) => row.harness === 'navi-c')).toBe(true)
    })
})

describe('orphan cleanup migration', () => {
    it('removes records whose canvas is gone and is idempotent', async () => {
        await expect(harnessesService.removeOrphanHarnesses()).resolves.toEqual({ removed: ['navi-harness'] })
        expect(has('navi-harness')).toBe(false)
        expect(schedules.has('navi-harness')).toBe(false)
        expect(runRows.some((row) => row.harness === 'navi-harness')).toBe(false)
        expect(['NAVI-B', 'navi'].map(has)).toEqual([true, true])
        await expect(harnessesService.removeOrphanHarnesses()).resolves.toEqual({ removed: [] })
    })

    it('rechecks the record under the name lock and leaves a harness saved under the name meanwhile', async () => {
        const CANVAS_NEW = 'canvas-new'
        let sweep: Promise<{ removed: string[] }> | undefined
        await harnessesService.withNameLock('navi-harness', async () => {
            sweep = harnessesService.removeOrphanHarnesses()
            await new Promise((resolve) => setTimeout(resolve, 20))
            canvases.set(CANVAS_NEW, { workspaceId: 'team-b', type: 'HARNESS' })
            write({ name: 'navi-harness', chatflowId: CANVAS_NEW, workspaceId: 'team-b', specialists: [{ name: 'scout' }] })
        })
        await expect(sweep).resolves.toEqual({ removed: [] })
        expect(has('navi-harness')).toBe(true)
        expect(JSON.parse(fs.readFileSync(fileOf('navi-harness'), 'utf8'))).toMatchObject({ chatflowId: CANVAS_NEW })
        expect(cleaned).not.toContain('navi-harness')
    })

    it('keeps a record when the canvas lookup fails', async () => {
        canvases.set(CANVAS_GONE, 'fail')
        await expect(harnessesService.removeOrphanHarnesses()).resolves.toEqual({ removed: [] })
        expect(has('navi-harness')).toBe(true)
    })
})

describe('orphan on the list and when opened', () => {
    it('marks the orphan on the list and keeps it deletable', async () => {
        const list = await harnessesService.listHarnesses(TEAM)
        expect(list.find((row: { name: string }) => row.name === 'navi-harness')).toMatchObject({ orphaned: true })
        expect(list.find((row: { name: string }) => row.name === 'navi')).not.toHaveProperty('orphaned')
    })

    it('flags the orphan when opened instead of failing', async () => {
        await expect(harnessesService.getHarness('navi-harness', TEAM)).resolves.toMatchObject({ name: 'navi-harness', orphaned: true })
        await expect(harnessesService.getHarness('navi', TEAM)).resolves.not.toHaveProperty('orphaned')
    })
})
