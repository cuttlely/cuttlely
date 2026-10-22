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

import harnessesService, { harnessCanvasLookup, harnessDeleteHooks, removeHarnessesForCanvas, setHarnessModuleLoader } from './index'
import { removeHarnessFromKeyLists } from './apiAccess'

const TEAM = 'team-a'
const CANVAS_NAVI = '11111111-1111-4111-8111-111111111111'
const CANVAS_GONE = '22222222-2222-4222-8222-222222222222'

type Row = { name: string; chatflowId?: string; workspaceId?: string; specialists: unknown[] }
let files: Map<string, Row>
let runRows: Array<{ table: string; harness: string }>
let schedules: Set<string>
let canvases: Map<string, { workspaceId: string; type: string } | 'fail'>
let storeDir: string

const fakeModules = (file: string) => {
    if (file === 'store.mjs') {
        return Promise.resolve({
            listHarnesses: () => [...files.values()].map((row) => ({ ...row })),
            getHarness: (name: string) => (files.has(name) ? { ...files.get(name) } : null),
            deleteHarness: (name: string) => void files.delete(name),
            claimWorkspace: (name: string) => files.get(name)
        })
    }
    if (file === 'schedule.mjs') return Promise.resolve({ deleteSchedule: (name: string) => schedules.delete(name) })
    if (file === 'paths.mjs') return Promise.resolve({ harnessStoreDir: () => storeDir })
    if (file === 'lock.mjs') {
        return Promise.resolve({
            immediate: (fn: (db: unknown) => void) =>
                fn({
                    prepare: (sql: string) => ({
                        all: () => [{ name: 'run_history' }, { name: 'run_results' }],
                        run: (name: string) => {
                            const table = /FROM (\w+)/.exec(sql)?.[1]
                            runRows = runRows.filter((row) => !(row.table === table && row.harness === name))
                        }
                    })
                })
        })
    }
    return Promise.reject(new Error(`unexpected module ${file}`))
}

const originalHooks = { ...harnessDeleteHooks }
const originalFind = harnessCanvasLookup.find

beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-delete-'))
    files = new Map([
        ['navi', { name: 'navi', chatflowId: CANVAS_NAVI, workspaceId: TEAM, specialists: [{ name: 'scout' }] }],
        ['NAVI-B', { name: 'NAVI-B', workspaceId: TEAM, specialists: [{ name: 'scout' }, { name: 'writer' }] }],
        ['navi-harness', { name: 'navi-harness', chatflowId: CANVAS_GONE, workspaceId: TEAM, specialists: [{ name: 'scout' }] }]
    ])
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
        await removeHarnessesForCanvas(chatflowId, workspaceId)
    })
    ;(removeHarnessFromKeyLists as jest.Mock).mockClear()
})

afterEach(() => {
    setHarnessModuleLoader(null)
    Object.assign(harnessDeleteHooks, originalHooks)
    harnessCanvasLookup.find = originalFind
    fs.rmSync(storeDir, { recursive: true, force: true })
})

describe('card delete', () => {
    it('removes the canvas, the record, its schedule, key grants and runs', async () => {
        await expect(harnessesService.deleteHarness('navi', TEAM)).resolves.toEqual({ name: 'navi', deleted: true, canvasDeleted: true })
        expect(harnessDeleteHooks.deleteCanvas).toHaveBeenCalledWith(CANVAS_NAVI, TEAM)
        expect(canvases.has(CANVAS_NAVI)).toBe(false)
        expect(files.has('navi')).toBe(false)
        expect(schedules.has('navi')).toBe(false)
        expect(removeHarnessFromKeyLists).toHaveBeenCalledWith(TEAM, 'navi')
        expect(runRows.some((row) => row.harness === 'navi')).toBe(false)
        expect(runRows.filter((row) => row.harness === 'NAVI-B')).toHaveLength(2)
    })

    it('removes a harness with no canvas directly', async () => {
        await harnessesService.deleteHarness('NAVI-B', TEAM)
        expect(harnessDeleteHooks.deleteCanvas).not.toHaveBeenCalled()
        expect(files.has('NAVI-B')).toBe(false)
    })

    it('deletes an orphan card', async () => {
        await harnessesService.deleteHarness('navi-harness', TEAM)
        expect(files.has('navi-harness')).toBe(false)
    })

    it('keeps the harness when the canvas cannot be read', async () => {
        canvases.set(CANVAS_NAVI, 'fail')
        await expect(harnessesService.deleteHarness('navi', TEAM)).rejects.toMatchObject({ statusCode: 503 })
        expect(files.has('navi')).toBe(true)
    })

    it('is a 404 for another team', async () => {
        await expect(harnessesService.deleteHarness('navi', 'team-b')).rejects.toMatchObject({ statusCode: 404 })
        expect(files.has('navi')).toBe(true)
    })
})

describe('canvas delete cascade', () => {
    it('removes every harness record built on the canvas', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM)
        expect(cascade.names).toEqual(['navi'])
        expect(files.has('navi')).toBe(false)
        expect(schedules.has('navi')).toBe(false)
        expect(files.has('NAVI-B')).toBe(true)
    })

    it('leaves a record in another team alone', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, 'team-b')
        expect(cascade.names).toEqual([])
        expect(files.has('navi')).toBe(true)
    })

    it('throws and keeps the record when its schedule cannot be removed, so the transaction rolls back', async () => {
        harnessDeleteHooks.removeSchedule = async () => {
            throw new Error('schedule store locked')
        }
        await expect(removeHarnessesForCanvas(CANVAS_NAVI, TEAM)).rejects.toMatchObject({ statusCode: 500 })
        expect(files.has('navi')).toBe(true)
    })

    it('restore writes the record back when the transaction fails after the cascade', async () => {
        const cascade = await removeHarnessesForCanvas(CANVAS_NAVI, TEAM)
        await cascade.restore()
        const written = JSON.parse(fs.readFileSync(path.join(storeDir, 'navi.json'), 'utf8'))
        expect(written).toMatchObject({ name: 'navi', chatflowId: CANVAS_NAVI, workspaceId: TEAM })
    })
})

describe('orphan cleanup migration', () => {
    it('removes records whose canvas is gone and is idempotent', async () => {
        await expect(harnessesService.removeOrphanHarnesses()).resolves.toEqual({ removed: ['navi-harness'] })
        expect(files.has('navi-harness')).toBe(false)
        expect(schedules.has('navi-harness')).toBe(false)
        expect(runRows.some((row) => row.harness === 'navi-harness')).toBe(false)
        expect([...files.keys()].sort()).toEqual(['NAVI-B', 'navi'])
        await expect(harnessesService.removeOrphanHarnesses()).resolves.toEqual({ removed: [] })
    })

    it('keeps a record when the canvas lookup fails', async () => {
        canvases.set(CANVAS_GONE, 'fail')
        await expect(harnessesService.removeOrphanHarnesses()).resolves.toEqual({ removed: [] })
        expect(files.has('navi-harness')).toBe(true)
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
