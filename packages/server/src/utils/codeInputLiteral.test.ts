/**
 * Request values in code inputs of Multi-Agent and Sequential Agent flows are written as escaped text, never as code.
 * The escape helper is checked on its own, then through the real buildAgentGraph with a stand-in Sequential Agent node whose
 * code inputs reference an allowlisted variable, and the resolved code is actually run.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { escapeForCodeInput, getCodeInputNames, varNameOfPath } from './codeInputLiteral'
import { buildAgentGraph } from './buildAgentGraph'

jest.mock('./logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))
jest.mock('typeorm', () => ({ ...jest.requireActual('typeorm'), Equal: (value: unknown) => value }))

const INJECTION = `"; globalThis.pwned = true; "' + (globalThis.pwned = true) + '\`\${globalThis.pwned = true}\`\n//`
const VALUES = ['eu', 'Zürich 東京 😀', INJECTION, 'a\\b\u2028c', '</script><!--', '-->', '${x}', '0x41', '']

/** Runs `source` in a fresh context and returns { result, pwned }. */
const run = (source: string) => {
    const context: Record<string, unknown> = {}
    const result = vm.runInNewContext(source, context)
    return { result, pwned: context.pwned === true }
}

/** vm contexts have their own SyntaxError class, so match on the error name. */
const syntaxErrorOf = (fn: () => unknown): string | undefined => {
    try {
        fn()
    } catch (e: any) {
        return e?.name
    }
    return undefined
}

describe('escapeForCodeInput', () => {
    it.each(VALUES)('reads back as the same text inside double, single and template quotes and in a regex: %j', (value) => {
        const esc = escapeForCodeInput(value)
        expect(run(`"${esc}"`)).toEqual({ result: value, pwned: false })
        expect(run(`'${esc}'`)).toEqual({ result: value, pwned: false })
        expect(run(`\`${esc}\``)).toEqual({ result: value, pwned: false })
        expect(run(`/^${esc}$/.test(${JSON.stringify(value)})`)).toEqual({ result: true, pwned: false })
    })

    it.each(VALUES.filter((v) => v !== ''))('outside quotes it never runs as code (syntax error): %j', (value) => {
        expect(syntaxErrorOf(() => run(`const v = ${escapeForCodeInput(value)}; v`))).toBe('SyntaxError')
        expect(() => run(`// note ${escapeForCodeInput(value)}\nglobalThis.pwned`)).not.toThrow()
        expect(run(`// note ${escapeForCodeInput(value)}\nglobalThis.pwned`).pwned).toBe(false)
    })

    it('keeps digits, so a number outside quotes still reads as a number; other values are stringified first', () => {
        expect(escapeForCodeInput('2026')).toBe('2026')
        expect(run(`${escapeForCodeInput('2026')} + 1`).result).toBe(2027)
        expect(escapeForCodeInput(7)).toBe('7')
        expect(run(`"${escapeForCodeInput({ a: '"' })}"`).result).toBe('{"a":"\\""}')
    })

    it('escapes every ASCII letter and symbol, so no identifier, keyword or punctuation survives', () => {
        expect(escapeForCodeInput('process.env')).toMatch(/^(\\x[0-9a-f]{2})+$/)
        expect(escapeForCodeInput('é')).toBe('\\xe9')
        expect(escapeForCodeInput('東')).toBe('\\u6771')
    })
})

describe('getCodeInputNames and varNameOfPath', () => {
    it('finds code inputs at the top level, inside tabs and inside array rows', () => {
        const params = [
            { name: 'systemMessagePrompt', type: 'string' },
            { name: 'messageHistory', type: 'code' },
            {
                name: 'updateStateMemory',
                type: 'tabs',
                tabs: [
                    { name: 'updateStateMemoryUI', type: 'datagrid' },
                    { name: 'updateStateMemoryCode', type: 'code' }
                ]
            },
            { name: 'rows', type: 'array', array: [{ name: 'jsonSchema', type: 'code' }] }
        ]
        expect([...getCodeInputNames(params)].sort()).toEqual(['jsonSchema', 'messageHistory', 'updateStateMemoryCode'])
        expect(getCodeInputNames(undefined).size).toBe(0)
    })

    it('takes the first segment of a $vars path', () => {
        expect(varNameOfPath('$vars.region')).toBe('region')
        expect(varNameOfPath('$vars.cfg.host')).toBe('cfg')
        expect(varNameOfPath('$vars.list[0]')).toBe('list')
    })
})

describe('Sequential Agent code inputs through buildAgentGraph', () => {
    let fixturePath = ''
    beforeAll(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-input-'))
        fixturePath = path.join(dir, 'RecordingNode.js')
        fs.writeFileSync(
            fixturePath,
            [
                'class RecordingNode {',
                '  async init(nodeData) {',
                '    ;(globalThis.__ci = globalThis.__ci || []).push({ name: nodeData.name, inputs: JSON.parse(JSON.stringify(nodeData.inputs)) })',
                "    throw new Error('ci stop')",
                '  }',
                '}',
                'module.exports = { nodeClass: RecordingNode }',
                ''
            ].join('\n')
        )
    })

    const INPUT_PARAMS = [
        { name: 'systemMessagePrompt', type: 'string' },
        { name: 'updateStateMemory', type: 'tabs', tabs: [{ name: 'updateStateMemoryCode', type: 'code' }] },
        { name: 'messageHistory', type: 'code' }
    ]
    const INPUTS = {
        systemMessagePrompt: 'Answer for {{$vars.region}} ({{$vars.tier}})',
        updateStateMemoryCode: 'return { region: "{{$vars.region}}", tier: "{{$vars.tier}}", pwned: globalThis.pwned === true }',
        messageHistory: 'return {{$vars.region}}'
    }

    const seqNode = (id: string, name: string, label: string, extra: Record<string, unknown> = {}) => ({
        id,
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: {
            id,
            name,
            label,
            category: 'Sequential Agents',
            inputs: {},
            inputParams: [],
            inputAnchors: [],
            outputAnchors: [],
            outputs: {},
            instance: { name, label },
            ...extra
        }
    })

    const dbVariables = () => [
        { id: '1', name: 'region', type: 'static', value: 'us', workspaceId: 'w1', createdDate: new Date(0), updatedDate: new Date(0) },
        { id: '2', name: 'tier', type: 'static', value: 'gold', workspaceId: 'w1', createdDate: new Date(0), updatedDate: new Date(0) }
    ]

    const agentInputs = async (apiConfig: Record<string, unknown>, region: unknown) => {
        ;(globalThis as any).__ci = []
        const nodes: any[] = [
            seqNode('seqStart_0', 'seqStart', 'Start'),
            seqNode('seqAgent_0', 'seqAgent', 'Agent', { inputs: { ...INPUTS }, inputParams: INPUT_PARAMS }),
            seqNode('seqEnd_0', 'seqEnd', 'End')
        ]
        const componentNodes: Record<string, any> = {}
        for (const n of nodes) componentNodes[n.data.name] = { filePath: fixturePath }
        const depthQueue: Record<string, number> = {}
        nodes.forEach((n, i) => (depthQueue[n.id] = i))
        await expect(
            buildAgentGraph({
                agentflow: {
                    id: 'f1',
                    name: 'ci',
                    flowData: '{}',
                    workspaceId: 'w1',
                    apiConfig: JSON.stringify({ overrideConfig: apiConfig })
                } as any,
                flowConfig: {
                    chatflowid: 'f1',
                    chatflowId: 'f1',
                    chatId: 'c1',
                    sessionId: 's1',
                    chatHistory: [],
                    apiMessageId: 'm1'
                } as any,
                incomingInput: { question: 'hi', streaming: false, overrideConfig: { vars: { region, tier: 'EVIL-TIER' } } } as any,
                nodes: [],
                edges: [],
                initializedNodes: nodes,
                endingNodeIds: ['seqEnd_0'],
                startingNodeIds: ['seqStart_0'],
                depthQueue,
                chatHistory: [],
                uploadedFilesContent: '',
                appDataSource: { getRepository: () => ({ findBy: async () => dbVariables() }) } as any,
                componentNodes,
                sseStreamer: new Proxy({}, { get: () => jest.fn() }) as any,
                shouldStreamResponse: false,
                cachePool: {} as any,
                baseURL: 'http://127.0.0.1',
                orgId: 'o1',
                workspaceId: 'w1'
            })
        ).rejects.toThrow('ci stop')
        return (globalThis as any).__ci.find((r: any) => r.name === 'seqAgent').inputs
    }

    const regionOn = { status: true, nodes: {}, variables: [{ id: 'region', name: 'region', type: 'static', enabled: true }] }
    const runCode = (code: string) => run(`(function () { ${code} })()`)

    it('an injection attempt in an allowlisted variable stays text in state update code and does not run', async () => {
        const inputs = await agentInputs(regionOn, INJECTION)
        expect(runCode(inputs.updateStateMemoryCode)).toEqual({ result: { region: INJECTION, tier: 'gold', pwned: false }, pwned: false })
        // Outside quotes the value cannot become code: the node's code fails to compile instead.
        expect(syntaxErrorOf(() => runCode(inputs.messageHistory))).toBe('SyntaxError')
        // Text inputs keep the documented behavior: the request value as text.
        expect(inputs.systemMessagePrompt).toBe(`Answer for ${INJECTION} (gold)`)
        // The request value is still available to code as data through inputs.vars ($vars in the node's sandbox).
        expect(inputs.vars).toEqual({ region: INJECTION })
    })

    it('a plain allowlisted value reads exactly as before inside quotes, and a number still works outside quotes', async () => {
        const inputs = await agentInputs(regionOn, 'eu')
        expect(runCode(inputs.updateStateMemoryCode).result).toEqual({ region: 'eu', tier: 'gold', pwned: false })
        expect(inputs.systemMessagePrompt).toBe('Answer for eu (gold)')
        const numeric = await agentInputs(regionOn, '42')
        expect(runCode(numeric.messageHistory).result).toBe(42)
    })

    it('saved values and overrides-off requests are inserted unchanged, as before', async () => {
        const off = await agentInputs({ ...regionOn, status: false }, INJECTION)
        expect(off.updateStateMemoryCode).toBe('return { region: "us", tier: "gold", pwned: globalThis.pwned === true }')
        expect(off.messageHistory).toBe('return us')
    })
})
