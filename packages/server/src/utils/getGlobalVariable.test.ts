/**
 * {{$vars}} is built only from the variables the caller resolved. A request config that carries `vars`
 * (with any shape of `enabled` flag) must not change a variable: agent graphs merge allowlisted request
 * values through getAllowedVariables before they get here, and other flow types use inputs.vars.
 */
jest.mock('./logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))

type Var = { name: string; type: string; value: string; id: string; updatedDate: Date; createdDate: Date; workspaceId: string }

const dbVars = (): Var[] => [
    { name: 'region', type: 'static', value: 'us', id: '1', updatedDate: new Date(0), createdDate: new Date(0), workspaceId: 'w1' },
    { name: 'tier', type: 'static', value: 'gold', id: '2', updatedDate: new Date(0), createdDate: new Date(0), workspaceId: 'w1' }
]

describe('getGlobalVariable and $vars resolution ignore request vars', () => {
    let getGlobalVariable: any
    let getVariableValue: any

    beforeAll(async () => {
        const mod = await import('./index')
        getGlobalVariable = mod.getGlobalVariable
        getVariableValue = mod.getVariableValue
    })

    it('returns the stored values and reads runtime variables from the environment', async () => {
        process.env.CUTTLELY_TEST_RUNTIME_VAR = 'from-env'
        const vars = await getGlobalVariable([
            ...dbVars(),
            { ...dbVars()[0], name: 'CUTTLELY_TEST_RUNTIME_VAR', type: 'runtime', value: 'ignored' }
        ])
        expect(vars).toEqual({ region: 'us', tier: 'gold', CUTTLELY_TEST_RUNTIME_VAR: 'from-env' })
        delete process.env.CUTTLELY_TEST_RUNTIME_VAR
    })

    it('takes only the resolved variable list, so there is no request config to trust', () => {
        expect(getGlobalVariable.length).toBe(0) // one optional parameter with a default
    })

    it.each([
        ['enabled true', true],
        ['enabled "true"', 'true'],
        ['enabled "false"', 'false'],
        ['enabled 1', 1]
    ])('a flow config carrying vars (%s) changes no variable and adds none', async (_label, enabled) => {
        const stored = dbVars()
        const flowConfig = { chatflowid: 'f1', vars: { region: 'EVIL', tier: 'EVIL', injected: 'EVIL' } }
        // The overrides list rides on the flow config too: nothing may read it.
        const config = {
            ...flowConfig,
            variableOverrides: [
                { name: 'region', enabled },
                { name: 'injected', enabled }
            ]
        }
        const text = 'r={{$vars.region}} t={{$vars.tier}} i={{$vars.injected}}'
        const out = await getVariableValue(text, [], 'q', [], true, config, '', stored)
        expect(out).toBe('r=us t=gold i={{$vars.injected}}')
        // The caller's (shared, per-workspace) list is not mutated.
        expect(stored).toEqual(dbVars())
    })
})
