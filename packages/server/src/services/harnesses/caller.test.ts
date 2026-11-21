import fs from 'fs'
import os from 'os'
import path from 'path'
import harnessesService, { setHarnessModuleLoader } from './index'

// Every harness route and the publish check name a caller. These refusals come before the harness is read.
describe('harness run caller', () => {
    const body = { question: 'How many loaves?' }

    it('refuses a run request with no caller, or with a keyless flow as the caller', async () => {
        await expect(harnessesService.assertRunRequest('bakery', body, 'team-a', undefined)).rejects.toMatchObject({ statusCode: 403 })
        await expect(harnessesService.assertRunRequest('bakery', body, 'team-a', { via: 'flow' })).rejects.toMatchObject({
            statusCode: 403
        })
    })

    it('refuses an API key whose list does not name the harness, or that has no id', async () => {
        await expect(
            harnessesService.assertRunRequest('payroll', body, 'team-a', { via: 'api_key', apiKeyId: 'key-1', harnesses: ['bakery'] })
        ).rejects.toMatchObject({ statusCode: 403, message: 'This API key may not run harness "payroll".' })
        await expect(
            harnessesService.assertRunRequest('bakery', body, 'team-a', { via: 'api_key', apiKeyId: '', harnesses: ['bakery'] })
        ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('refuses a publish-check replay of a harness the key does not list, before the canvas is read', async () => {
        const chatflow = { id: 'flow-1', name: 'payroll', flowData: '{"nodes":[],"edges":[]}', workspaceId: 'team-a' }
        await expect(
            harnessesService.replayCheck(chatflow, chatflow.flowData, body, {
                caller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['bakery'] }
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        await expect(harnessesService.replayCheck(chatflow, chatflow.flowData, body, { caller: undefined })).rejects.toMatchObject({
            statusCode: 403
        })
    })
})

// A key is admitted (and its quota charged) only for a run that can start. Clients retry on Retry-After while the
// agent runtime is down, so admission after the runtime check would bill every retry.
describe('background run while the agent runtime is unavailable', () => {
    const body = { question: 'How many loaves?' }
    let dataDir = ''
    let previousDataDir: string | undefined

    const setRuntime = (state: string) =>
        fs.writeFileSync(path.join(dataDir, 'hermes-supervisor.json'), JSON.stringify({ state, restarts: 0, pid: 0 }))

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-admission-'))
        previousDataDir = process.env.CUTTLELY_DATA_DIR
        process.env.CUTTLELY_DATA_DIR = dataDir
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'store.mjs')
                return {
                    getHarness: (name: string) => (name === 'bakery' ? { name: 'bakery', workspaceId: 'team-a', specialists: [] } : null)
                }
            throw new Error(`stop after admission: ${file}`)
        })
    })

    afterEach(() => {
        setHarnessModuleLoader(null)
        if (previousDataDir === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previousDataDir
        fs.rmSync(dataDir, { recursive: true, force: true })
    })

    it.each(['down', 'restarting', 'cooldown', 'exhausted'])(
        'refuses with RUNTIME_UNAVAILABLE and never admits the key (%s)',
        async (state) => {
            setRuntime(state)
            const admit = jest.fn(async () => ({ via: 'session' as const }))
            await expect(
                harnessesService.startBackgroundRun('bakery', body, { workspaceId: 'team-a', caller: { via: 'session' }, admit })
            ).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE', statusCode: 503 })
            expect(admit).not.toHaveBeenCalled()
        }
    )

    it('admits the key when the runtime is up', async () => {
        setRuntime('up')
        const admit = jest.fn(async () => ({ via: 'session' as const }))
        await expect(
            harnessesService.startBackgroundRun('bakery', body, { workspaceId: 'team-a', caller: { via: 'session' }, admit })
        ).rejects.toThrow('stop after admission: history.mjs')
        expect(admit).toHaveBeenCalledTimes(1)
    })
})
