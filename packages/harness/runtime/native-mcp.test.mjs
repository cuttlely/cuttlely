import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { rosterFromFlow } from '../sync-from-flow.mjs'
import { nativeMcpBindingSupported, openNativeMcpTools } from './native-mcp.mjs'

const components = createRequire(new URL('../../components/package.json', import.meta.url))
const canvas = JSON.parse(fs.readFileSync(new URL('../../../samples/harnesses/ops.canvas.json', import.meta.url)))
const binding = rosterFromFlow({ ...canvas, name: 'test', chatflowId: 'saved-ops', workspaceId: 'fixture-workspace' }).specialists[0]
    .mcpServers[0]
const options = { scope: ['fixture-workspace', 'saved-ops', '', 'one', 'operator'], assertCurrent() {} }
function setGrant(t) {
    const settings = {
        CUSTOM_MCP_PROTOCOL: 'stdio',
        CUSTOM_MCP_ALLOWED_COMMANDS: 'node',
        CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS: 'samples/ops-mcp-server.mjs',
        CUSTOM_MCP_SECURITY_CHECK: 'true'
    }
    for (const [key, value] of Object.entries(settings)) {
        const original = process.env[key]
        process.env[key] = value
        t.after(() => (original === undefined ? delete process.env[key] : (process.env[key] = original)))
    }
}

test('a saved read-only MCP binding runs its selected action with the same bytes and schema as its released canvas tool', async (t) => {
    setGrant(t)
    const { MCPToolkit } = components('@cuttlely/components/nodes')
    const toolkit = new MCPToolkit(JSON.parse(binding.inputs.mcpServerConfig), 'stdio')
    t.after(() => toolkit.client?.close())
    await toolkit.initialize()
    const expected = await toolkit.tools.find((tool) => tool.name === 'ops_status').invoke({})
    assert.equal(expected, '[{"type":"text","text":"ops-status: allowlisted MCP tool responded"}]')
    const native = await openNativeMcpTools([binding], options)
    t.after(() => native.close())
    assert.deepEqual(
        native.tools.map((tool) => tool.function.name),
        ['ops_status']
    )
    assert.deepEqual(native.tools[0].function.parameters, toolkit._tools.tools[0].inputSchema)
    assert.equal(await native.call('ops_status', {}), expected)
    await assert.rejects(native.call('unassigned', {}), { code: 'forbidden' })
})

test('native admission requires packaged code, unmodified startup arguments and read-only actions', () => {
    const config = JSON.parse(binding.inputs.mcpServerConfig)
    const withConfig = (patch) => ({ ...binding, inputs: { ...binding.inputs, mcpServerConfig: JSON.stringify({ ...config, ...patch }) } })
    assert.ok(nativeMcpBindingSupported(binding))
    for (const patch of [
        { args: ['samples/another-tool.mjs'] },
        { args: [...config.args, 'additional-argument'] },
        { command: 'other-binary' },
        { cwd: '/tmp' },
        { env: {} },
        { url: 'https://example.invalid' }
    ])
        assert.equal(nativeMcpBindingSupported(withConfig(patch)), false)
    assert.equal(nativeMcpBindingSupported({ ...binding, upstream: { source: {} } }), false)
    assert.equal(nativeMcpBindingSupported({ ...binding, inputs: { ...binding.inputs, mcpActions: ['other'] } }), false)
    assert.ok(nativeMcpBindingSupported({ ...binding, inputs: { ...binding.inputs, mcpActions: '["ops_status"]' } }))
})

test('a revoked host policy or roster prevents dispatch, and closed MCP sessions cannot be reused', async (t) => {
    setGrant(t)
    let allowed = true
    const native = await openNativeMcpTools([binding], {
        ...options,
        assertCurrent: () => {
            if (!allowed) throw new Error('Roster revoked')
        }
    })
    t.after(() => native.close())
    process.env.CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS = ''
    await assert.rejects(native.call('ops_status', {}), { code: 'forbidden' })
    await assert.rejects(openNativeMcpTools([binding], options), { code: 'forbidden' })
    process.env.CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS = 'samples/ops-mcp-server.mjs'
    allowed = false
    await assert.rejects(native.call('ops_status', {}), /Roster revoked/)
    allowed = true
    await native.close()
    await assert.rejects(native.call('ops_status', {}), { name: 'AbortError' })
    process.env.CUSTOM_MCP_PROTOCOL = 'sse'
    await assert.rejects(openNativeMcpTools([binding], options), { code: 'forbidden' })
})

test('an empty first discovery retries, expected results stay usable, and three transport failures cool down only their own chat', async (t) => {
    setGrant(t)
    const { Client } = components('@modelcontextprotocol/sdk/client/index.js')
    const original = Client.prototype.listTools
    let listings = 0
    t.mock.method(Client.prototype, 'listTools', function (...args) {
        if (!listings++) return Promise.resolve({ tools: [] })
        return original.apply(this, args)
    })
    const native = await openNativeMcpTools([binding], options)
    t.after(() => native.close())
    assert.equal(listings, 2)
    let calls = 0
    t.mock.method(Client.prototype, 'callTool', async () => {
        calls++
        if (calls === 3) return { isError: true, structuredContent: { cuttlelyOutcome: 'expected' }, content: [] }
        throw new Error('Disconnected')
    })
    const fail = () => assert.rejects(native.call('ops_status', {}), { code: 'tool_unavailable' })
    await fail()
    await fail()
    assert.deepEqual(await native.call('ops_status', {}), { content: '[]', error: true })
    await fail()
    await fail()
    await fail()
    await fail()
    assert.equal(calls, 6)
    const before = listings
    await assert.rejects(openNativeMcpTools([binding], options), /cooldown/)
    assert.equal(listings, before)
    const sibling = await openNativeMcpTools([binding], { ...options, scope: [...options.scope, 'sibling'] })
    t.after(() => sibling.close())
    await assert.rejects(sibling.call('ops_status', {}), /could not complete/)
    assert.equal(calls, 7)
})

test('cancelling an outstanding protocol operation closes its process and prevents another dispatch', async (t) => {
    setGrant(t)
    const { Client } = components('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = components('@modelcontextprotocol/sdk/client/stdio.js')
    const closed = []
    const original = StdioClientTransport.prototype.close
    t.mock.method(StdioClientTransport.prototype, 'close', async function () {
        if (this.pid) closed.push(this.pid)
        return original.call(this)
    })
    const entered = Promise.withResolvers()
    t.mock.method(Client.prototype, 'callTool', (_params, _schema, { signal }) => {
        entered.resolve()
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const native = await openNativeMcpTools([binding], { ...options, scope: ['cancel'] })
    const request = native.call('ops_status', {})
    const rejection = assert.rejects(request, { name: 'AbortError' })
    await entered.promise
    await native.close()
    await rejection
    assert.equal(closed.length, 2)
    for (const pid of closed) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
