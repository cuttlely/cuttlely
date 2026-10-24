import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { HarnessError } from './errors.mjs'
import { repoRoot } from './paths.mjs'
import { getHarness } from './store.mjs'

export async function executeModule(binding, input, options = {}) {
    const prepared = await prepareModule(binding, input, options)
    if (options.toolName) prepared.toolName = options.toolName
    // Preparing a node awaits; the caller may refuse the call at this point (a token revoked meanwhile).
    if (options.beforeCall) await options.beforeCall()
    // Checked again with nothing awaited before the tool starts: the await above yields, and a revocation may run there.
    if (options.assertCall) options.assertCall()
    const raw = await callPrepared(prepared, input, options.assertCall)
    return prepared.runs ? raw : normalizeResult(raw)
}

export async function prepareModule(binding, input, options = {}) {
    if (!binding?.nodeName) {
        throw new HarnessError('bad_binding', 'A harness module binding needs a Flowise node name.')
    }
    const cache = options.nodeCache instanceof Map ? options.nodeCache : new Map()
    const flowOptions = options.flowOptions || {}
    assertServerContext(flowOptions)
    const ctx = { ...options, flowOptions }
    const { instance, nodeData, ready } = await startNode(binding, ctx, cache, input)
    const runs = typeof instance.run === 'function'
    const tool = runs ? null : firstTool(ready)
    return { binding, instance, nodeData, flowOptions, ready, runs, tool }
}

// Initializes upstream bindings first and injects each init result over inputs.
// cache is per run, keyed by nodeId, and is never stored on this module.
export async function resolveInputs(binding, ctx, cache, input) {
    const shared = cache instanceof Map ? cache : new Map()
    const injected = {}
    for (const [name, upstream] of Object.entries(binding?.upstream || {})) {
        injected[name] = Array.isArray(upstream)
            ? await Promise.all(upstream.map((item) => initBinding(item, ctx, shared, input)))
            : await initBinding(upstream, ctx, shared, input)
    }
    return {
        id: binding.nodeId || binding.nodeName,
        name: binding.nodeName,
        label: binding.label,
        category: binding.category,
        outputs: binding.outputs || { output: 'text' },
        ...(binding.credential ? { credential: binding.credential } : {}),
        ...(binding.nodeData || {}),
        inputs: { ...(binding.inputs || {}), ...injected }
    }
}

function startNode(binding, ctx, cache, input) {
    const id = binding?.nodeId
    if (id && cache.has(id)) return cache.get(id)
    const work = buildNode(binding, ctx, cache, input)
    if (id) cache.set(id, work)
    return work
}

const SERVER_CONTEXT = 'Harness tools need the Cuttlely server context; run them through a chat flow.'

function assertServerContext(flowOptions) {
    if (!flowOptions?.appDataSource) throw new HarnessError('no_flow_context', SERVER_CONTEXT)
}

// Chatflow Tool is recognized by its selectedChatflow input, not by the node name.
function assertNotCallerChatflow(binding, flowOptions) {
    const inputs = binding?.inputs
    if (!inputs || typeof inputs !== 'object') return
    const selected = inputs.selectedChatflow ?? inputs.selectedChatflowId
    if (typeof selected === 'string' && selected && selected === flowOptions?.callerChatflowId) {
        throw new HarnessError('bad_binding', 'Cannot call the same chatflow!')
    }
}

async function buildNode(binding, ctx, cache, input) {
    const flowOptions = ctx.flowOptions || {}
    assertServerContext(flowOptions)
    assertNotCallerChatflow(binding, flowOptions)
    const instance = await freshNodeInstance(binding.nodeName, ctx)
    const nodeData = await resolveInputs(binding, ctx, cache, input)
    const ready = typeof instance.init === 'function' ? await instance.init(nodeData, input, flowOptions) : undefined
    return { instance, nodeData, ready }
}

async function initBinding(binding, ctx, cache, input) {
    const loaded = await startNode(binding, ctx, cache, input)
    return loaded.ready
}

// assertCall, when given, runs before each further attempt of a tool (a retry with another argument shape), with
// nothing awaited in between, so a revocation during an attempt stops the retries.
export async function callPrepared(prepared, input, assertCall) {
    if (prepared.runs) return prepared.instance.run(prepared.nodeData, textInput(input), prepared.flowOptions)
    return readyRaw(prepared.ready, input, prepared.toolName, assertCall)
}

export function preparedKind(prepared) {
    if (prepared.runs) return 'text'
    const ready = prepared.ready
    if (prepared.tool) return prefersObject(prepared.tool) ? 'object' : 'text'
    if (ready && (typeof ready.getRelevantDocuments === 'function' || typeof ready.similaritySearch === 'function')) return 'query'
    return 'text'
}

export function preparedSchema(prepared) {
    const kind = preparedKind(prepared)
    if (kind === 'query') {
        return { type: 'object', properties: { query: { type: 'string', description: 'What to look up.' } }, required: ['query'] }
    }
    if (kind === 'object') {
        const schema = jsonSchemaFor(prepared.tool)
        if (schema) return schema
    }
    return { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
}

function firstTool(ready) {
    if (Array.isArray(ready)) return ready.find((item) => item && typeof item.invoke === 'function') || null
    return ready && typeof ready.invoke === 'function' ? ready : null
}

function jsonSchemaFor(tool) {
    const schema = tool?.schema
    if (!schema) return null
    if (schema.type === 'object' && schema.properties) return schema
    try {
        const toJson = zodToJsonSchema()
        const converted = toJson ? toJson(schema, { target: 'openApi3' }) : null
        if (converted && converted.type === 'object') {
            delete converted.$schema
            return converted
        }
    } catch {
        return null
    }
    return null
}

let zodConverter
function zodToJsonSchema() {
    if (zodConverter !== undefined) return zodConverter
    try {
        const require = createRequire(path.join(repoRoot(), 'packages', 'components', 'package.json'))
        const mod = require('zod-to-json-schema')
        zodConverter = mod.zodToJsonSchema || mod.default || null
    } catch {
        zodConverter = null
    }
    return zodConverter
}

function textInput(input) {
    return typeof input === 'string' ? input : JSON.stringify(input ?? '')
}

function prefersObject(tool) {
    const typeName = tool?.schema?._def?.typeName || tool?.schema?.type
    return Boolean(typeName && typeName !== 'ZodString' && typeName !== 'string')
}

// A model often names the one argument after the tool ({"query": ...} for a tool whose only field is "sql").
// When the schema has exactly one string field and the call has exactly one string value, retry under that name.
function renamedSingleField(tool, input) {
    let keys = []
    let shape = null
    try {
        shape = typeof tool.schema?._def?.shape === 'function' ? tool.schema._def.shape() : tool.schema?.shape
    } catch {
        shape = null
    }
    if (shape && typeof shape === 'object') keys = Object.keys(shape)
    else if (tool.schema?.type === 'object' && tool.schema.properties) {
        keys = Object.keys(tool.schema.properties).filter((key) => tool.schema.properties[key]?.type === 'string')
        if (keys.length !== Object.keys(tool.schema.properties).length) return []
    }
    const given = Object.keys(input)
    if (keys.length !== 1 || given.length !== 1 || given[0] === keys[0] || typeof input[given[0]] !== 'string') return []
    return [{ [keys[0]]: input[given[0]] }]
}

// A wrong argument shape is the only reason to try the next shape. A database
// refusal (timeout, permission denied) already ran the statement. A later shape
// check must not replace that message.
function argumentShapeError(error) {
    if (String(error?.name || '') === 'ZodError') return true
    return /did not match expected schema/i.test(String(error?.message || ''))
}

function argumentFor(tool, text) {
    let shape = null
    try {
        shape = typeof tool.schema?._def?.shape === 'function' ? tool.schema._def.shape() : tool.schema?.shape
    } catch {
        shape = null
    }
    if (!shape || typeof shape !== 'object') return { input: text }
    const keys = Object.keys(shape)
    if (keys.length === 1) return { [keys[0]]: text }
    if (keys.includes('input')) return { input: text }
    return { input: text }
}

async function invokeTool(tool, input, assertCall) {
    const text = textInput(input)
    const structured = input && typeof input === 'object' && !Array.isArray(input)
    const attempts = structured
        ? prefersObject(tool)
            ? [...renamedSingleField(tool, input), input, text]
            : [typeof input.input === 'string' ? input.input : text]
        : prefersObject(tool)
        ? [argumentFor(tool, text), text]
        : [text]
    let shapeError
    for (const [index, attempt] of attempts.entries()) {
        if (index && assertCall) assertCall()
        try {
            return await tool.invoke(attempt)
        } catch (error) {
            if (!argumentShapeError(error)) throw error
            shapeError = error
        }
    }
    throw shapeError
}

function queryText(input) {
    if (input && typeof input === 'object' && typeof input.query === 'string') return input.query
    if (input && typeof input === 'object' && typeof input.input === 'string') return input.input
    return textInput(input)
}

function toolsOf(ready) {
    if (Array.isArray(ready)) return ready.filter((item) => item && typeof item.invoke === 'function')
    if (ready && typeof ready.invoke === 'function') return [ready]
    return []
}

async function readyRaw(ready, input, toolName, assertCall) {
    if (ready == null) return ''
    if (Array.isArray(ready)) {
        const tools = toolsOf(ready)
        const tool = (toolName && tools.find((item) => item.name === toolName)) || tools[0]
        if (!tool) return ready
        return readyRaw(tool, input, '', assertCall)
    }
    if (typeof ready.invoke === 'function') return invokeTool(ready, input, assertCall)
    if (typeof ready.getRelevantDocuments === 'function') return ready.getRelevantDocuments(queryText(input))
    if (typeof ready.similaritySearch === 'function') return ready.similaritySearch(queryText(input), ready.k || 4)
    return ready
}

// Flowise tools append these blocks to their text output (packages/components/src/agents.ts).
const SOURCE_DOCUMENTS_PREFIX = '\n\n----FLOWISE_SOURCE_DOCUMENTS----\n\n'
const FLOWISE_PREFIXES = [SOURCE_DOCUMENTS_PREFIX, '\n\n----FLOWISE_ARTIFACTS----\n\n', '\n\n----FLOWISE_TOOL_ARGS----\n\n']
const PATH_KEY = /^(source|file|filename|filepath|file_path|path|fullpath|absolutepath)$|path$/i

function textBeforePrefixes(text) {
    let end = text.length
    for (const prefix of FLOWISE_PREFIXES) {
        const at = text.indexOf(prefix)
        if (at !== -1 && at < end) end = at
    }
    return text.slice(0, end)
}

function isDocument(item) {
    return Boolean(item) && typeof item === 'object' && typeof item.pageContent === 'string'
}

function isServerPath(value) {
    return typeof value === 'string' && (/^\/[^/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('file://'))
}

// A source document as callers see it: absolute server paths in path-like metadata become the file name.
export function publicDocument(doc) {
    const metadata = {}
    for (const [key, value] of Object.entries(doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {})) {
        metadata[key] =
            PATH_KEY.test(key) && isServerPath(value) ? path.basename(value.replace(/^file:\/\//, '').replace(/\\/g, '/')) : value
    }
    return { pageContent: doc.pageContent, metadata }
}

// Splits a tool or retriever result into the text a model reads and the source documents it carries.
export function splitToolOutput(raw) {
    if (Array.isArray(raw)) return { text: normalizeResult(raw), documents: raw.filter(isDocument).map(publicDocument) }
    if (typeof raw !== 'string') return { text: normalizeResult(raw), documents: [] }
    const text = textBeforePrefixes(raw)
    const at = raw.indexOf(SOURCE_DOCUMENTS_PREFIX)
    if (at === -1) return { text, documents: [] }
    const tail = raw.slice(at + SOURCE_DOCUMENTS_PREFIX.length)
    let documents = []
    try {
        const parsed = JSON.parse(textBeforePrefixes(tail))
        documents = (Array.isArray(parsed) ? parsed : []).filter(isDocument).map(publicDocument)
    } catch {
        documents = []
    }
    return { text, documents }
}

export function normalizeResult(result) {
    if (result == null) return ''
    if (typeof result === 'string') return textBeforePrefixes(result)
    if (typeof result === 'number' || typeof result === 'boolean') return String(result)
    if (Array.isArray(result)) {
        return result
            .map((item) => (item && typeof item === 'object' && item.pageContent ? item.pageContent : normalizeResult(item)))
            .filter(Boolean)
            .join('\n')
    }
    if (typeof result === 'object') {
        if (typeof result.content === 'string') return result.content
        if (typeof result.pageContent === 'string') return result.pageContent
        try {
            return JSON.stringify(result)
        } catch {
            return String(result)
        }
    }
    return String(result)
}

// A new instance on every call. Reading filePath does not construct the pooled NodesPool proxy.
export async function freshNodeInstance(nodeName, ctx = {}) {
    const filePath = ctx.componentNodes?.[nodeName]?.filePath
    if (filePath) {
        try {
            const mod = await import(pathToFileURL(filePath).href)
            const NodeClass = mod.nodeClass || mod.default?.nodeClass
            if (!NodeClass) {
                throw new HarnessError(
                    'module_unavailable',
                    `Harness cannot run module "${nodeName}": ${filePath} does not export nodeClass.`
                )
            }
            return new NodeClass()
        } catch (error) {
            if (error?.harnessError) throw error
            throw new HarnessError('module_unavailable', `Harness cannot run module "${nodeName}": ${error.message}`)
        }
    }
    if (typeof ctx.loadNode === 'function') {
        const loaded = await ctx.loadNode(nodeName)
        const NodeClass = loaded?.nodeClass || loaded
        return new NodeClass()
    }
    return loadFlowiseNode(nodeName)
}

function nodeSearchRoots() {
    const root = repoRoot()
    const pairs = [[path.join(root, 'packages', 'components', 'dist', 'nodes'), path.join(root, 'packages', 'components', 'nodes')]]
    const packagesDir = path.join(root, 'packages')
    if (fs.existsSync(packagesDir)) {
        for (const name of fs.readdirSync(packagesDir)) {
            if (!name.startsWith('node-pack-')) continue
            pairs.push([path.join(packagesDir, name, 'dist', 'nodes'), path.join(packagesDir, name, 'nodes')])
        }
    }
    return pairs
}

export async function loadFlowiseNode(nodeName) {
    let match = null
    for (const [distRoot, nodesRoot] of nodeSearchRoots()) {
        match = findNodeFile(distRoot, nodeName) || findNodeFile(nodesRoot, nodeName)
        if (match) break
    }
    if (!match) {
        throw new HarnessError('module_unavailable', `Harness module "${nodeName}" is not registered.`)
    }
    if (match.endsWith('.ts')) {
        throw new HarnessError(
            'module_unavailable',
            `Harness cannot run module "${nodeName}": the Flowise node is TypeScript and the components package has not been built (${path.relative(
                repoRoot(),
                match
            )}).`
        )
    }
    try {
        const loaded = await import(pathToFileURL(match).href)
        const NodeClass = loaded.nodeClass || loaded.default?.nodeClass
        if (!NodeClass) {
            throw new HarnessError('module_unavailable', `Harness cannot run module "${nodeName}": ${match} does not export nodeClass.`)
        }
        return new NodeClass()
    } catch (error) {
        if (error?.harnessError) throw error
        throw new HarnessError('module_unavailable', `Harness cannot run module "${nodeName}": ${error.message}`)
    }
}

const nodeFileCache = new Map()

function findNodeFile(root, nodeName) {
    const key = `${root}\0${nodeName}`
    if (nodeFileCache.has(key)) return nodeFileCache.get(key)
    const found = scanNodeFile(root, nodeName)
    if (found) nodeFileCache.set(key, found)
    return found
}

function scanNodeFile(root, nodeName) {
    if (!fs.existsSync(root)) return null
    const named = []
    const stack = [root]
    while (stack.length) {
        const dir = stack.pop()
        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                stack.push(full)
                continue
            }
            if (!/\.(js|cjs|mjs|ts)$/.test(entry.name) || entry.name.endsWith('.d.ts') || entry.name.includes('.test.')) continue
            const base = entry.name.replace(/\.(js|cjs|mjs|ts)$/i, '')
            if (base.toLowerCase() === String(nodeName).toLowerCase()) named.push(full)
        }
    }
    const namedMatch = named.find((full) => nodeFileExports(full, nodeName))
    if (namedMatch) return namedMatch
    stack.push(root)
    while (stack.length) {
        const dir = stack.pop()
        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                stack.push(full)
                continue
            }
            if (named.includes(full)) continue
            if (!/\.(js|cjs|mjs|ts)$/.test(entry.name) || entry.name.endsWith('.d.ts') || entry.name.includes('.test.')) continue
            if (nodeFileExports(full, nodeName)) return full
        }
    }
    return null
}

function nodeFileExports(full, nodeName) {
    const text = fs.readFileSync(full, 'utf8')
    return text.includes(`this.name = '${nodeName}'`) || text.includes(`this.name = "${nodeName}"`)
}

// A canvas Custom MCP node is initialized in-process. A typed mcpServers extra is not.
export function isFlowiseMcpBinding(binding) {
    return binding?.nodeName === 'customMCP' || binding?.category === 'Tools (MCP)'
}

export function readyToolSpecs(prepared) {
    return toolsOf(prepared?.ready).map((tool) => {
        const name = String(tool.name || prepared.binding?.label || prepared.binding?.nodeName || 'tool')
        return {
            name,
            description: String(tool.description || prepared.binding?.description || name),
            inputSchema: jsonSchemaFor(tool) || { type: 'object', properties: { input: { type: 'string' } } }
        }
    })
}

// Tool names must match ^[A-Za-z0-9_-]{1,64}$, so anything else becomes an underscore.
const TOOL_NAME_MAX = 64

function edgeMark(char) {
    return char === '_' || char === '-'
}

// Linear on any input: one replace, then the edges are trimmed by index rather than by an anchored regex.
export function toolNameFrom(text) {
    const name = String(text ?? '')
        .slice(0, 1024)
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
    let start = 0
    let end = name.length
    while (start < end && edgeMark(name[start])) start += 1
    while (end > start && edgeMark(name[end - 1])) end -= 1
    return name.slice(start, end).slice(0, TOOL_NAME_MAX)
}

function baseToolName(binding) {
    return (
        toolNameFrom(binding?.inputs?.name) ||
        toolNameFrom(binding?.nodeName) ||
        toolNameFrom(binding?.serverName) ||
        toolNameFrom(binding?.label) ||
        'module'
    )
}

const NODE_SUFFIX_MAX = 24

function compareKeys(left, right) {
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] < right[i]) return -1
        if (left[i] > right[i]) return 1
    }
    return 0
}

// A cleaned name never holds two underscores in a row, so a suffix after "__" can never equal a plain
// name, and adding a node can never take a name another node already has.
function withSuffix(base, suffix) {
    const tail = `__${suffix}`
    return `${base.slice(0, TOOL_NAME_MAX - tail.length)}${tail}`
}

// A short suffix that belongs to the node: its id when that is short, else a hash of the id.
function nodeSuffix(binding, index) {
    const id = String(binding?.nodeId || '')
    const clean = toolNameFrom(id)
    // An id is used as is only when cleaning left it unchanged, so two ids never share a suffix that way.
    if (clean && clean === id && clean.length <= NODE_SUFFIX_MAX) return clean
    if (id) return `n${createHash('sha256').update(id).digest('hex').slice(0, 10)}`
    return String(index + 1)
}

// One tool name per wired node, from the node's own name input. A name only that node wants is kept
// as is. When nodes share a name, every one of them takes "__" and its node id as a suffix, so a name
// always belongs to the same node. Plain and suffixed names never overlap, and suffixed names are given
// out in node id order, so reordering, adding or removing other nodes never hands an advertised name
// to a different node. reserved holds names already taken, such as the tools an MCP server advertises.
export function specialistToolBindings(specialist, reserved = new Set()) {
    const bindings = [...(specialist?.modules || []), ...(specialist?.mcpServers || [])]
    const items = bindings.map((binding, index) => ({ binding, index, base: baseToolName(binding), suffix: nodeSuffix(binding, index) }))
    const counts = new Map()
    for (const item of items) counts.set(item.base, (counts.get(item.base) || 0) + 1)
    const taken = new Set(reserved)
    const names = new Map()
    for (const item of items) {
        if (counts.get(item.base) === 1 && !taken.has(item.base)) {
            names.set(item, item.base)
            taken.add(item.base)
        }
    }
    const rest = items
        .filter((item) => !names.has(item))
        .sort((x, y) =>
            compareKeys([x.base, x.suffix, String(x.binding?.nodeId || '')], [y.base, y.suffix, String(y.binding?.nodeId || '')])
        )
    for (const item of rest) {
        let name = withSuffix(item.base, item.suffix)
        // The counter keeps its room in the 64 characters, so this always ends.
        for (let n = 2; taken.has(name); n += 1) name = withSuffix(item.base, `${item.suffix}_${n}`)
        names.set(item, name)
        taken.add(name)
    }
    return items.map((item) => ({ name: names.get(item), index: item.index, nodeId: item.binding?.nodeId || '', binding: item.binding }))
}

export function specialistToolName(specialist, binding, reserved) {
    return specialistToolBindings(specialist, reserved).find((entry) => entry.binding === binding)?.name || baseToolName(binding)
}

// The gateway passes the node it advertised under the called name: a node id, or the binding's place.
function routedBinding(specialist, options) {
    const all = [...(specialist.modules || []), ...(specialist.mcpServers || [])]
    if (options.nodeId) return all.find((binding) => binding?.nodeId === options.nodeId) || null
    if (Number.isInteger(options.bindingIndex)) return all[options.bindingIndex] || null
    return null
}

function bindingForToolName(specialist, toolName) {
    const entry = specialistToolBindings(specialist).find((item) => item.name === toolName)
    if (!entry) return null
    if (!entry.nodeId) return entry.binding
    const all = [...(specialist.modules || []), ...(specialist.mcpServers || [])]
    return all.find((binding) => binding?.nodeId === entry.nodeId) || entry.binding
}

export function specialistByName(harness, name) {
    return (harness.specialists || []).find((specialist) => specialist.name === name) || null
}

export async function executeSpecialistTool(harnessName, specialistName, toolName, args, options = {}) {
    const harness = options.harness || getHarness(harnessName)
    if (!harness) {
        throw new HarnessError('not_found', `Harness "${harnessName}" was not found.`)
    }
    const specialist = specialistByName(harness, specialistName)
    if (!specialist) {
        throw new HarnessError('not_found', `Specialist "${specialistName}" is not on harness "${harnessName}".`)
    }
    if (options.forceSpecialistFailure === specialistName) {
        throw new HarnessError('specialist_failed', `Specialist "${specialistName}" failed.`)
    }
    const modules = specialist.modules || []
    const mcpServers = specialist.mcpServers || []
    // Route by the node behind the advertised name, so nodes of one type each get their own calls.
    const binding =
        routedBinding(specialist, options) ||
        bindingForToolName(specialist, toolName) ||
        modules.find((mod) => mod.nodeName === toolName || mod.label === toolName) ||
        mcpServers.find((mod) => mod.nodeName === toolName || mod.serverName === toolName || mod.label === toolName) ||
        modules[0] ||
        mcpServers[0]
    if (!binding) {
        throw new HarnessError('bad_binding', `Specialist "${specialistName}" has no module on its allowlist.`)
    }
    // A Flowise MCP tool advertised its own input schema (readyToolSpecs), so pass the arguments through as an object.
    const structured = isFlowiseMcpBinding(binding) && args && typeof args === 'object' && !Array.isArray(args)
    const input = structured
        ? args
        : typeof args?.input === 'string'
        ? args.input
        : typeof args?.query === 'string'
        ? args.query
        : JSON.stringify(args || {})
    return executeModule(binding, input, { ...options, toolName })
}
