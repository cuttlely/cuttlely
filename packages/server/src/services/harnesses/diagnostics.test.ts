import service, { setHarnessModuleLoader } from './index'

const readClaims = jest.fn(() => ({ runId: 'run_example', harness: 'example', claims: [] }))
const readRun = jest.fn(() => ({ id: 'run_example' }))

beforeEach(() => {
    readClaims.mockClear()
    readRun.mockClear()
    readRun.mockReturnValue({ id: 'run_example' })
    setHarnessModuleLoader(async (file: string) => {
        if (file === 'store.mjs') return { getHarness: () => ({ name: 'example', workspaceId: 'team-a' }) }
        if (file === 'history.mjs') return { getRun: readRun, getRunDiagnostics: readClaims }
        throw new Error(`Unexpected module ${file}`)
    })
})

afterEach(() => setHarnessModuleLoader(null))

it('reads diagnostics only after checking the harness workspace and run identity', async () => {
    expect(await service.getRunDiagnostics('example', 'run_example', 'team-a')).toEqual({
        runId: 'run_example',
        harness: 'example',
        claims: []
    })
    expect(readRun).toHaveBeenCalledWith('example', 'run_example', { apiKeyId: null })
    expect(readClaims).toHaveBeenCalledWith('example', 'run_example')
})

it('does not read any history for a harness in another workspace', async () => {
    await expect(service.getRunDiagnostics('example', 'run_example', 'team-b')).rejects.toMatchObject({ statusCode: 404 })
    expect(readRun).not.toHaveBeenCalled()
    expect(readClaims).not.toHaveBeenCalled()
})

it('does not read diagnostics for an unknown run', async () => {
    readRun.mockReturnValueOnce(null as never)
    await expect(service.getRunDiagnostics('example', 'run_missing', 'team-a')).rejects.toMatchObject({ statusCode: 404 })
    expect(readClaims).not.toHaveBeenCalled()
})
