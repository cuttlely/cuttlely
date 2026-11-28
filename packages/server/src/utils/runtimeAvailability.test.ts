import fs from 'fs'
import os from 'os'
import path from 'path'
import { assertFlowRuntimeAvailable, assertRuntimeAvailable } from './runtimeAvailability'

describe('runtime admission', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-runtime-admission-'))
    const previous = process.env.CUTTLELY_DATA_DIR
    beforeEach(() => {
        process.env.CUTTLELY_DATA_DIR = dir
    })
    afterAll(() => {
        if (previous === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previous
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test.each(['down', 'restarting', 'cooldown', 'exhausted'])('refuses execution when runtime is %s', (state) => {
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state }))
        expect(() => assertRuntimeAvailable()).toThrow(/agent runtime is unavailable/i)
        expect(() => assertFlowRuntimeAvailable({ type: 'HARNESS', flowData: '{}' })).toThrow(/runtime is unavailable/i)
        expect(() => assertFlowRuntimeAvailable({ flowData: JSON.stringify({ nodes: [{ data: { name: 'harness' } }] }) })).toThrow(
            /runtime is unavailable/i
        )
        expect(() =>
            assertFlowRuntimeAvailable({
                type: 'AGENTFLOW',
                flowData: JSON.stringify({ nodes: [{ data: { name: 'agent', inputs: { tools: [{ agentSelectedTool: 'harness' }] } } }] })
            })
        ).toThrow(/runtime is unavailable/i)
        expect(() =>
            assertFlowRuntimeAvailable({ flowData: JSON.stringify({ nodes: [{ data: { name: 'tool', inputs: { name: 'harness' } } }] }) })
        ).not.toThrow()
    })

    test('a static native selection cannot exempt a dynamic, mixed, malformed or overridden harness caller', () => {
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state: 'down' }))
        const previous = process.env.CUTTLELY_NATIVE_PRIME_TEAMS
        process.env.CUTTLELY_NATIVE_PRIME_TEAMS = 'eligible'
        try {
            const selected = { data: { name: 'harness', inputs: { harnessName: 'eligible' } } }
            const check = (nodes: unknown[], overrides?: unknown) =>
                assertFlowRuntimeAvailable({ type: 'CHATFLOW', workspaceId: 'fixture', flowData: JSON.stringify({ nodes }) }, overrides)
            for (const other of [
                { data: { name: 'agent', inputs: { tools: [{ agentSelectedTool: 'harness' }] } } },
                { data: { name: 'chatflowTool', inputs: { selectedChatflow: 'other-flow' } } },
                { data: { name: 'harness', inputs: { harnessName: 'other' } } },
                { data: { name: 'harness', inputs: { harnessName: ['eligible'] } } }
            ])
                expect(() => check([selected, other])).toThrow(/agent runtime is unavailable/i)
            for (const overrides of [
                { harnessName: 'other' },
                { vars: { target: 'other' } },
                { managedUploadReceipts: [], harnessName: 'other' },
                true
            ]) {
                expect(() => check([selected], overrides)).toThrow(/agent runtime is unavailable/i)
            }
        } finally {
            if (previous === undefined) delete process.env.CUTTLELY_NATIVE_PRIME_TEAMS
            else process.env.CUTTLELY_NATIVE_PRIME_TEAMS = previous
        }
    })

    test('a saved Tool Agent checks its statically connected team in the caller workspace while the bundled runtime is unavailable', async () => {
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state: 'down' }))
        const availability = require('../../../harness/availability.cjs')
        const target = jest.spyOn(availability, 'assertSelectedHarnessAvailable').mockImplementation(() => undefined)
        const selected = jest
            .spyOn(availability, 'selectAgentEngine')
            .mockImplementation((name: unknown) => (name === 'upload' ? 'native' : 'hermes'))
        const sample = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../..', 'samples/chatflows/upload.chatflow.json'), 'utf8'))
        const original = JSON.parse(sample.flowData)
        const check = (graph: typeof original, overrides?: unknown) =>
            assertFlowRuntimeAvailable({ type: 'CHATFLOW', workspaceId: 'owner-workspace', flowData: JSON.stringify(graph) }, overrides)
        try {
            await check(original, { sessionId: 'a' })
            expect(target).toHaveBeenCalledTimes(1)
            expect(target).toHaveBeenCalledWith('upload', { workspaceId: 'owner-workspace' })
            target.mockClear()
            for (const modify of [
                (g: typeof original) => {
                    g.nodes.push(null)
                },
                (g: typeof original) => {
                    g.nodes[0].data.name = 'chatflowTool'
                    g.nodes[0].data.category = 'Chat Models'
                },
                (g: typeof original) => {
                    g.nodes[2].data.inputs.harnessName = '{{caller.target}}'
                },
                (g: typeof original) => {
                    g.nodes[2].data.inputs.harnessName = 'foreign'
                },
                (g: typeof original) => {
                    g.nodes[2].id = g.nodes[0].id
                },
                (g: typeof original) => {
                    g.nodes[3].data.inputs.tools = ['{{caller.tools}}']
                },
                (g: typeof original) => {
                    g.nodes[3].data.inputs.tools = [{ agentSelectedTool: 'harness' }]
                },
                (g: typeof original) => {
                    g.edges[0].target = g.nodes[2].id
                },
                (g: typeof original) => {
                    g.edges[0] = g.edges[1]
                }
            ]) {
                const modified = JSON.parse(sample.flowData)
                modify(modified)
                expect(() => check(modified)).toThrow(/runtime is unavailable/i)
            }
            expect(() => check(original, { harnessName: 'foreign' })).toThrow(/runtime is unavailable/i)
            expect(target).not.toHaveBeenCalled()
        } finally {
            target.mockRestore()
            selected.mockRestore()
        }
    })

    test.each(['up', 'degraded'])('allows execution while runtime is %s', (state) => {
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state }))
        expect(() => assertRuntimeAvailable()).not.toThrow()
    })
})
