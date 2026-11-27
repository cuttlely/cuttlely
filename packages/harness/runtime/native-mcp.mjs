import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { harnessToolTimeoutMs } from '../budget.mjs'
import { HarnessError } from '../errors.mjs'
import { repoRoot } from '../paths.mjs'

const components = createRequire(new URL('../../components/package.json', import.meta.url))
// Each entry names shipped code and the operations exercised as read-only. The canvas selects
// an entry; its command, paths, environment and model arguments never become launch options.
const packagedServers = new Map([['samples/ops-mcp-server.mjs', new Set(['ops_status'])]])

function parse(value) {
    return typeof value === 'string' ? JSON.parse(value) : value
}

function packagedBinding(binding) {
    if (binding?.nodeName !== 'customMCP' || Object.keys(binding.upstream || {}).length) return
    let config, actions
    try {
        config = parse(binding.inputs?.mcpServerConfig)
        actions = parse(binding.inputs?.mcpActions || [])
    } catch {
        return
    }
    if (!config || Object.keys(config).length !== 2 || config.command !== 'node' || !Array.isArray(config.args) || config.args.length !== 1)
        return
    const entry = [...packagedServers.keys()].find((script) =>
        [script, './' + script, path.join(repoRoot(), script)].includes(config.args[0])
    )
    if (!entry || !Array.isArray(actions) || !actions.every((name) => packagedServers.get(entry).has(name))) return
    return { entry, config, actions }
}

export function nativeMcpBindingSupported(binding) {
    return Boolean(packagedBinding(binding))
}

function assertHostGrant(config) {
    if (process.env.CUSTOM_MCP_PROTOCOL !== 'stdio') throw new HarnessError('forbidden', 'The host has not enabled local MCP servers.')
    // Match the Custom MCP node's operator policy, including its exact path comparison.
    if (process.env.CUSTOM_MCP_SECURITY_CHECK !== 'false') {
        try {
            components('@cuttlely/components/nodes').validateMCPServerConfig(config)
        } catch {
            throw new HarnessError('forbidden', 'The host has not granted this MCP command and script path.')
        }
    }
}

// Match the bundled runtime's three-strike, one-minute cooldown. Only failing chats use space.
// A successful call, including an expected empty result, clears the streak.
const failures = new Map()
function noteFailure(key) {
    const at = performance.now()
    const strikes = (failures.get(key)?.strikes || 0) + 1
    failures.delete(key)
    if (failures.size >= 4096) failures.delete(failures.keys().next().value)
    failures.set(key, { strikes, until: strikes >= 3 ? at + 60000 : 0 })
}

function checkCircuit(key) {
    if (performance.now() < (failures.get(key)?.until || 0)) {
        throw new HarnessError('tool_unavailable', 'The MCP server has failed repeatedly in this chat. Try again after its cooldown.')
    }
}

export async function openNativeMcpTools(bindings, { signal, assertCurrent, scope }) {
    const controller = new AbortController()
    const activeSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    const pending = new Set()
    const routes = new Map()
    const tools = []
    function check(config) {
        activeSignal.throwIfAborted()
        assertCurrent()
        assertHostGrant(config)
    }
    // Discovery and each call get their own protocol session just as Custom MCP does. A closed
    // transport is never reused by a later call or by another chat.
    function withClient(server, operation) {
        check(server.config)
        const { Client } = components('@modelcontextprotocol/sdk/client/index.js')
        const { StdioClientTransport } = components('@modelcontextprotocol/sdk/client/stdio.js')
        // The SDK starts close() without awaiting it on a failed initialize request. All paths must
        // join the same shutdown promise before releasing the delegation's worker resources.
        class ScopedClient extends Client {
            close() {
                return (this.closing ??= super.close())
            }
        }
        const client = new ScopedClient({ name: 'cuttlely', version: '1.0.0' })
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(repoRoot(), server.entry)],
            cwd: repoRoot(),
            stderr: 'ignore',
            maxBufferSize: 1024 * 1024
        })
        const timeout = harnessToolTimeoutMs() ?? 60000
        const options = { timeout, signal: AbortSignal.any([activeSignal, AbortSignal.timeout(timeout)]) }
        const work = (async () => {
            try {
                await client.connect(transport, options)
                check(server.config)
                return await operation(client, options)
            } finally {
                await client.close()
            }
        })()
        pending.add(work)
        return work.finally(() => pending.delete(work))
    }

    async function discover(server) {
        const key = JSON.stringify([scope, server.entry])
        checkCircuit(key)
        let found
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                found = await withClient(server, (client, options) => client.listTools({}, options))
                if (server.actions.every((name) => found.tools.some((tool) => tool.name === name))) break
                throw new Error('Missing assigned tool')
            } catch (error) {
                check(server.config)
                if (attempt === 1) {
                    noteFailure(key)
                    throw new HarnessError('tool_unavailable', 'Could not discover the assigned MCP tools.')
                }
            }
        }
        check(server.config)
        for (const tool of found.tools) {
            if (!server.actions.includes(tool.name) || routes.has(tool.name)) continue
            routes.set(tool.name, { server, key })
            tools.push({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })
        }
    }
    for (const binding of bindings) {
        const server = packagedBinding(binding)
        if (!server) throw new HarnessError('native_unsupported', 'This MCP binding requires the bundled runtime.')
        if (server.actions.length) await discover(server)
    }
    return {
        tools,
        async call(name, args) {
            const route = routes.get(name)
            if (!route) throw new HarnessError('forbidden', 'The requested MCP action is unavailable to this specialist.')
            const { server, key } = route
            check(server.config)
            checkCircuit(key)
            let result
            try {
                result = await withClient(server, (client, options) => client.callTool({ name, arguments: args }, undefined, options))
            } catch (error) {
                check(server.config)
                noteFailure(key)
                throw new HarnessError('tool_unavailable', 'The assigned MCP server could not complete the call.')
            }
            check(server.config)
            if (result.isError && result.structuredContent?.cuttlelyOutcome !== 'expected') {
                noteFailure(key)
                throw new HarnessError('tool_failed', 'The assigned MCP action failed.')
            }
            failures.delete(key)
            // The released canvas MCPTool returns this exact representation, including empty arrays.
            const content = JSON.stringify(result.content)
            return result.isError ? { content, error: true } : content
        },
        async close() {
            controller.abort()
            await Promise.allSettled([...pending])
        }
    }
}
