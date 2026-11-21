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

    test.each(['up', 'degraded'])('allows execution while runtime is %s', (state) => {
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state }))
        expect(() => assertRuntimeAvailable()).not.toThrow()
    })
})
