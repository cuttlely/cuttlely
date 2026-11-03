/**
 * Template variables are inserted exactly as written. Text that holds dollar-sign sequences such as $' $& $$ $1 or $`
 * must come out unchanged, the same as any other text.
 */
import { resolveVariables } from './buildAgentflow'

jest.mock('./logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))
jest.mock('@cuttlely/components', () => ({ ...jest.requireActual('@cuttlely/components'), tracingEnvEnabled: () => false }))

const samples = ["SELECT 'a$''b' AS x", 'price $& tax', 'cost $$5', 'group $1 and $<name>', 'before $` after', "$' $& $$ $1 $`"]

const node = (template: string) =>
    ({
        id: 'n',
        inputs: { value1: template },
        inputParams: [{ name: 'value1', acceptVariable: true }]
    } as any)

describe('resolveVariables keeps dollar-sign text exactly as written', () => {
    it.each(samples)('{{ question }} with %s', async (text) => {
        const out = await resolveVariables(node('{{ question }}'), text, {}, undefined, [], '', [], {} as any)
        expect(out.inputs?.value1).toBe(text)
        expect(out.inputs?.value1.length).toBe(text.length)
    })

    it.each(samples)('$flow, $vars and $form with %s', async (text) => {
        const vars = [{ name: 'note', type: 'static', value: text, id: '1', workspaceId: 'w1' }] as any
        const out = await resolveVariables(
            node('[{{ $flow.state.note }}|{{ $vars.note }}|{{ $form.note }}]'),
            '',
            { note: text },
            { state: { note: text } } as any,
            vars,
            '',
            [],
            {} as any
        )
        expect(out.inputs?.value1).toBe(`[${text}|${text}|${text}]`)
    })
})
