import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { assertAuthenticatedRequests, good, tool, statusResponder } from '../../../scripts/fixtures/kraken-remote-mcp.mjs'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import envelope from '../../../scripts/credential-envelope.cjs'
import { nativeMcpBindingSupported, openNativeMcpTools } from './native-mcp.mjs'

const requireComponents = createRequire(new URL('../../components/package.json', import.meta.url))
function restoreEnv(t, overrides) {
    for (const [key, value] of Object.entries(overrides)) {
        const old = process.env[key]
        process.env[key] = value
        t.after(() => {
            if (old === undefined) delete process.env[key]
            else process.env[key] = old
        })
    }
}
async function fixture(t, mode) {
    const id = randomUUID(),
        workspaceId = randomUUID(),
        token = randomUUID(),
        key = randomUUID()
    const { control, seen, origin, close } = await statusResponder(mode, token)
    t.after(close)
    const grant = {
        workspaceId,
        serverId: id,
        url: origin + '/stream',
        actions: ['ops_status'],
        ...(mode === 'sse' ? { ssePostUrl: origin + '/events' } : {})
    }
    restoreEnv(t, {
        CUTTLELY_NATIVE_MCP_ENDPOINTS: JSON.stringify([grant]),
        HTTP_ALLOW_LOCALHOST: 'true',
        CUTTLELY_SECRETKEY_OVERWRITE: key
    })
    const stored = {
        id,
        workspaceId,
        status: 'AUTHORIZED',
        serverUrl: grant.url,
        authType: 'CUSTOM_HEADERS',
        authConfig: envelope.sealApplicationRecord(JSON.stringify({ headers: { authorization: 'Bearer ' + token } }), key, [
            'custom-mcp',
            id
        ]),
        tools: JSON.stringify({ tools: [tool] })
    }
    const flowOptions = {
        workspaceId,
        databaseEntities: { CustomMcpServer: Symbol() },
        appDataSource: {
            getRepository(entity) {
                assert.equal(entity, flowOptions.databaseEntities.CustomMcpServer)
                return {
                    async findOne(options) {
                        assert.deepEqual(options.where, { workspaceId, id })
                        return { ...stored }
                    }
                }
            }
        }
    }
    const binding = { nodeName: 'customMcpServerTool', inputs: { mcpServerId: id, mcpActions: '["ops_status"]' } }
    const controller = new AbortController()
    const options = { flowOptions, signal: controller.signal, scope: [workspaceId, 'fixture', randomUUID()], assertCurrent: () => {} }
    return { binding, control, controller, options, seen, stored, grant, origin, token }
}
for (const mode of ['http', 'sse']) {
    test('authenticated workspace status via ' + mode + ' uses real transport and only the saved no-argument grant', async (t) => {
        const f = await fixture(t, mode)
        assert.ok(nativeMcpBindingSupported(f.binding, f.grant.workspaceId))
        assert.equal(nativeMcpBindingSupported(f.binding, randomUUID()), false)
        const assigned = await openNativeMcpTools([f.binding], f.options)
        t.after(() => assigned.close())
        assert.deepEqual(
            assigned.tools.map((t) => t.function.name),
            ['ops_status']
        )
        const reply = await assigned.call('ops_status', {})
        assert.equal(reply, JSON.stringify([{ type: 'text', text: good }]))
        if (mode === 'http') {
            const { MCPToolkit } = requireComponents('@cuttlely/components/nodes')
            const reference = new MCPToolkit({ url: f.grant.url, headers: { Authorization: 'Bearer ' + f.token } }, 'sse')
            await reference.initialize()
            const released = reference.tools.find((t) => t.name === 'ops_status')
            assert.equal(reply, await released.invoke({}))
        }

        assertAuthenticatedRequests(f.seen)
        if (mode === 'http') assert.ok(f.seen.some((r) => r.method === 'DELETE'))
        assert.deepEqual(
            f.seen.filter((r) => r.name),
            Array.from({ length: mode === 'http' ? 2 : 1 }, () => ({ name: 'ops_status', args: {} }))
        )
        await assert.rejects(assigned.call('other', {}), { code: 'forbidden' })
        await assert.rejects(assigned.call('ops_status', { url: 'unassigned' }), { code: 'forbidden' })
        f.stored.status = 'PENDING'
        const before = f.seen.length
        await assert.rejects(assigned.call('ops_status', {}), { code: 'forbidden' })
        assert.equal(f.seen.length, before)
    })
}
test('workspace key, endpoint, caller and both stored and discovered contracts are rechecked', async (t) => {
    const f = await fixture(t, 'http')
    const assigned = await openNativeMcpTools([f.binding], f.options)
    t.after(() => assigned.close())
    const previous = f.stored.authConfig
    f.stored.authConfig = '{invalid}'
    const before = f.seen.length
    await assert.rejects(assigned.call('ops_status', {}), { code: 'forbidden' })
    assert.equal(f.seen.length, before)
    f.stored.authConfig = previous
    f.stored.serverUrl = f.origin + '/other'
    await assert.rejects(assigned.call('ops_status', {}), { code: 'forbidden' })
    f.stored.serverUrl = f.grant.url
    const incompatible = { ...tool, inputSchema: { type: 'object', properties: { input: { type: 'string' } } } }
    f.control.tool = incompatible
    await assert.rejects(assigned.call('ops_status', {}), { code: 'forbidden' })
    assert.equal(f.seen.filter((r) => r.name).length, 0)
    f.control.tool = tool
    f.stored.tools = JSON.stringify({ tools: [incompatible] })
    await assert.rejects(assigned.call('ops_status', {}), { code: 'forbidden' })
    delete process.env.CUTTLELY_NATIVE_MCP_ENDPOINTS
    assert.equal(nativeMcpBindingSupported(f.binding, f.grant.workspaceId), false)
    await assert.rejects(assigned.call('ops_status', {}), { code: 'forbidden' })
})
test('status would never send credentials to an unassigned redirect or separately advertised SSE endpoint', async (t) => {
    const f = await fixture(t, 'http')
    f.control.redirect = true
    await assert.rejects(openNativeMcpTools([f.binding], f.options))
    assert.equal(
        f.seen.some((r) => r.url === '/unapproved'),
        false
    )
    const legacy = await fixture(t, 'sse')
    legacy.control.path = '/other'
    await assert.rejects(openNativeMcpTools([legacy.binding], legacy.options))
    assert.equal(
        legacy.seen.some((r) => r.url?.startsWith('/other')),
        false
    )
})
test('remote control accepts cancellation and releases owned connections', async (t) => {
    const f = await fixture(t, 'http')
    const assigned = await openNativeMcpTools([f.binding], f.options)
    f.control.wait = true
    const arrived = new Promise((r) => {
        f.control.onCall = r
    })
    const work = assigned.call('ops_status', {})
    await arrived
    f.controller.abort()
    await assert.rejects(work, { name: 'AbortError' })
    await assigned.close()
    await assert.rejects(assigned.call('ops_status', {}), { name: 'AbortError' })
})
