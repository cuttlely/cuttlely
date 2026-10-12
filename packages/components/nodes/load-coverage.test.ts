import { spawnSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import https from 'https'
import net from 'net'
import path from 'path'
import tls from 'tls'

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true'
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true'

const repoRoot = path.resolve(__dirname, '../../..')
const nodesRoot = path.join(repoRoot, 'packages/components/nodes')

function credentialRoots(): string[] {
    const roots = [path.join(repoRoot, 'packages/components/credentials')]
    const packagesDir = path.join(repoRoot, 'packages')
    for (const name of fs.readdirSync(packagesDir)) {
        if (!name.startsWith('node-pack-')) continue
        const credentials = path.join(packagesDir, name, 'credentials')
        if (fs.existsSync(credentials)) roots.push(credentials)
    }
    return roots
}
const TIER_NAMES = ['core', 'supported', 'legacy', 'hidden']
const SCALAR = new Set([
    'asyncOptions',
    'asyncMultiOptions',
    'options',
    'multiOptions',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'array',
    'tabs',
    'conditionFunction',
    'timePicker',
    'weekDaysPicker',
    'monthDaysPicker',
    'datePicker'
])

type Problem = string
type Loaded = { nodeClass?: new () => Record<string, any> }
type CredentialModule = { credClass?: new () => Record<string, any> }

const outbound: string[] = []
const BROAD_INIT_SKIP = 'init needs a service, a file, or another node'

const originalHttpRequest = http.request
const originalHttpGet = http.get
const originalHttpsRequest = https.request
const originalHttpsGet = https.get
const originalNetConnect = net.connect
const originalTlsConnect = tls.connect
const originalFetch = globalThis.fetch

function blocked(kind: string) {
    return () => {
        outbound.push(kind)
        const error = new Error(`outbound call blocked (${kind})`) as NodeJS.ErrnoException
        error.code = 'OUTBOUND_BLOCKED'
        throw error
    }
}

function installOutboundBlock() {
    http.request = blocked('http.request') as typeof http.request
    http.get = blocked('http.get') as typeof http.get
    https.request = blocked('https.request') as typeof https.request
    https.get = blocked('https.get') as typeof https.get
    net.connect = blocked('net.connect') as typeof net.connect
    tls.connect = blocked('tls.connect') as typeof tls.connect
    globalThis.fetch = blocked('fetch') as typeof fetch
}

function restoreOutbound() {
    http.request = originalHttpRequest
    http.get = originalHttpGet
    https.request = originalHttpsRequest
    https.get = originalHttpsGet
    net.connect = originalNetConnect
    tls.connect = originalTlsConnect
    globalThis.fetch = originalFetch
}

const load = require as (id: string) => Loaded
const loadCredential = require as (id: string) => CredentialModule

function skippedCategories(): Set<string> {
    const source = fs.readFileSync(path.join(repoRoot, 'packages/server/src/NodesPool.ts'), 'utf8')
    const list = source.match(/const skipCategories = \[([^\]]*)\]/)
    if (!list) throw new Error('NodesPool skipCategories was not found')
    return new Set([...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]))
}

function walk(dir: string, predicate: (file: string) => boolean, files: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, predicate, files)
        else if (predicate(full)) files.push(full)
    }
    return files
}

function collectCredentialNames(value: unknown, into: string[], seen = new Set<unknown>()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
        for (const item of value) collectCredentialNames(item, into, seen)
        return
    }
    const record = value as Record<string, unknown>
    if (Array.isArray(record.credentialNames)) {
        for (const name of record.credentialNames) if (typeof name === 'string' && name) into.push(name)
    }
    collectCredentialNames(record.inputs, into, seen)
    collectCredentialNames(record.tabs, into, seen)
    collectCredentialNames(record.array, into, seen)
    if (record.credential && record.credential !== value) collectCredentialNames(record.credential, into, seen)
}

function checkInputs(inputs: unknown, where: string, problems: Problem[]) {
    if (inputs === undefined) return
    if (!Array.isArray(inputs)) {
        problems.push(`${where} inputs is not an array`)
        return
    }
    inputs.forEach((input, index) => {
        if (!input || typeof input !== 'object') {
            problems.push(`${where} input ${index} is not an object`)
            return
        }
        const record = input as Record<string, unknown>
        if (typeof record.name !== 'string' || !record.name) problems.push(`${where} input ${index} is missing a name`)
        if (typeof record.type !== 'string' || !record.type) problems.push(`${where} input ${index} is missing a type`)
        if (record.tabs) checkInputs(record.tabs, `${where} tab`, problems)
        if (record.array) checkInputs(record.array, `${where} array`, problems)
    })
}

function needsConnectedNode(inputs: unknown): boolean {
    if (!Array.isArray(inputs)) return false
    for (const input of inputs) {
        if (!input || typeof input !== 'object') continue
        const record = input as Record<string, unknown>
        if (record.type === 'tabs' && needsConnectedNode(record.tabs)) return true
        if (Array.isArray(record.array) && needsConnectedNode(record.array)) return true
        const optional = record.optional === true || (record.optional !== undefined && typeof record.optional === 'object')
        if (optional) continue
        if (typeof record.type !== 'string' || !SCALAR.has(record.type)) return true
    }
    return false
}

function initBody(source: string): string {
    const start = source.search(/async\s+init\s*\(/)
    if (start < 0) return ''
    const brace = source.indexOf('{', start)
    if (brace < 0) return ''
    let depth = 0
    for (let i = brace; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1
        else if (source[i] === '}') {
            depth -= 1
            if (depth === 0) return source.slice(brace, i + 1)
        }
    }
    return ''
}

function initSkipReason(instance: Record<string, any>, source: string): string {
    if (typeof instance.init !== 'function') return 'no init method'
    const credentialNames: string[] = []
    collectCredentialNames(instance, credentialNames)
    if (credentialNames.length) return 'needs a credential'
    if (needsConnectedNode(instance.inputs)) return 'init needs another node'
    const body = initBody(source)
    if (!body) return 'no init method'
    if (/getCredentialData\s*\(/.test(body)) return 'init reads a credential'
    if (/\bspawn\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|child_process/.test(body)) return 'init starts a process'
    if (
        /fetch\s*\(|axios\.|https?:\/\/|http\.request|https\.request|WebSocket|\bgrpc\b|net\.connect|tls\.connect|node-fetch|\bgot\s*\(|undici/.test(
            body
        )
    )
        return 'init reaches the network'
    if (/getVars\s*\(|appDataSource|executeJavaScriptCode|createCodeExecutionSandbox/.test(body))
        return 'init runs caller code or reads the database'
    if (!LOCAL_INIT_CATEGORIES.has(String(instance.category)) && !LOCAL_INIT_NAMES.has(String(instance.name))) return BROAD_INIT_SKIP
    return ''
}

function sampleInputs(inputs: unknown, into: Record<string, unknown>) {
    if (!Array.isArray(inputs)) return
    for (const input of inputs) {
        if (!input || typeof input !== 'object') continue
        const record = input as Record<string, any>
        if (typeof record.name !== 'string') continue
        if (record.type === 'tabs') {
            sampleInputs(record.tabs, into)
            continue
        }
        if (record.default !== undefined) {
            into[record.name] = record.default
            continue
        }
        if (record.optional === true) continue
        if (record.type === 'number') into[record.name] = 1
        else if (record.type === 'boolean') into[record.name] = false
        else if (record.type === 'json') into[record.name] = '{}'
        else if (record.type === 'code') into[record.name] = 'return input'
        else if (record.type === 'options' || record.type === 'asyncOptions') into[record.name] = record.options?.[0]?.name ?? ''
        else if (typeof record.type === 'string' && SCALAR.has(record.type)) into[record.name] = 'load-test'
    }
}

const LOCAL_INIT_CATEGORIES = new Set(['Text Splitters', 'Prompts', 'Output Parsers', 'Utilities', 'Cache'])
const LOCAL_INIT_NAMES = new Set(['calculator', 'localHashEmbeddings'])

const initOptions = {
    chatflowid: 'load-coverage',
    sessionId: 'load-coverage',
    chatId: 'load-coverage',
    isRun: false,
    dynamicVariables: {} as Record<string, unknown>,
    cachePool: {
        getLLMCache: async () => new Map(),
        addLLMCache: async () => undefined,
        getEmbeddingCache: async () => new Map(),
        addEmbeddingCache: async () => undefined
    }
}

// The load itself stays under a minute without instrumentation. Coverage collection
// (Jest's default babel provider) makes the same load slower than that, so the
// file timeout has to outlast a coverage run. The 60s figure is asserted below
// only when this process is not instrumented.
const LOAD_BUDGET_MS = 60_000
jest.setTimeout(180_000)

// Jest assigns this while requiring a file it rewrote for collectCoverage.
// Test files are left alone, so the map is empty until a node or credential loads.
function coverageInstrumentationOn(): boolean {
    const coverage = (globalThis as { __coverage__?: Record<string, unknown> }).__coverage__
    if (!coverage || typeof coverage !== 'object') return false
    const marker = `${path.sep}packages${path.sep}components${path.sep}`
    return Object.keys(coverage).some((file) => path.normalize(file).includes(marker))
}

describe('node and credential load coverage', () => {
    beforeAll(() => {
        installOutboundBlock()
    })

    afterAll(() => {
        restoreOutbound()
    })

    it('loads every catalog node and credential class without a network call', async () => {
        const started = Date.now()
        const problems: Problem[] = []
        const catalogCheck = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/build-module-catalog.mjs'), '--check'], {
            cwd: repoRoot,
            encoding: 'utf8'
        })
        if (catalogCheck.status !== 0) {
            problems.push(catalogCheck.stderr || catalogCheck.stdout || 'module catalog check failed')
        }

        const catalog = JSON.parse(fs.readFileSync(path.join(nodesRoot, 'module-catalog.json'), 'utf8'))
        const entries = catalog.nodes as Array<Record<string, string>>
        const skip = skippedCategories()
        const tierTotals = { core: 0, supported: 0, legacy: 0, hidden: 0 }
        const credentialClasses = new Map<string, Record<string, any>>()
        const inited: string[] = []
        const skips: Array<{ name: string; reason: string }> = []

        for (const credentialsRoot of credentialRoots()) {
            for (const file of walk(credentialsRoot, (candidate) => candidate.endsWith('.credential.ts'))) {
                let instance: Record<string, any>
                try {
                    const exported = loadCredential(file)
                    if (!exported.credClass) throw new Error('missing credClass')
                    instance = new exported.credClass()
                } catch (error) {
                    problems.push(`${path.relative(repoRoot, file)} failed to load: ${(error as Error).message}`)
                    continue
                }
                const where = path.relative(repoRoot, file)
                if (typeof instance.name !== 'string' || !instance.name) problems.push(`${where} is missing a name`)
                if (typeof instance.label !== 'string' || !instance.label) problems.push(`${where} is missing a label`)
                if (instance.version !== undefined && (typeof instance.version !== 'number' || !Number.isFinite(instance.version)))
                    problems.push(`${where} version is not a number`)
                checkInputs(instance.inputs, where, problems)
                if (instance.name && credentialClasses.has(instance.name))
                    problems.push(`credential name ${instance.name} is declared twice`)
                if (instance.name) credentialClasses.set(instance.name, instance)
            }
        }

        for (const entry of entries) {
            if (!TIER_NAMES.includes(entry.tier)) problems.push(`${entry.name} tier ${entry.tier} is not a support tier`)
            else tierTotals[entry.tier as keyof typeof tierTotals] += 1
            const abs = path.join(repoRoot, entry.file)
            let instance: Record<string, any>
            try {
                const exported = load(abs)
                if (!exported.nodeClass) throw new Error('missing nodeClass')
                instance = new exported.nodeClass()
            } catch (error) {
                problems.push(`${entry.file} failed to load: ${(error as Error).message}`)
                continue
            }
            if (instance.name !== entry.name) problems.push(`${entry.file} name is ${instance.name}, catalog says ${entry.name}`)
            if (instance.label !== entry.label) problems.push(`${entry.file} label is ${instance.label}, catalog says ${entry.label}`)
            if (instance.category !== entry.category)
                problems.push(`${entry.file} category is ${instance.category}, catalog says ${entry.category}`)
            if (typeof instance.version !== 'number' || !Number.isFinite(instance.version))
                problems.push(`${entry.name} version is not a number`)
            checkInputs(instance.inputs, entry.name, problems)
            const credentialNames: string[] = []
            collectCredentialNames(instance, credentialNames)
            for (const name of credentialNames) {
                if (!credentialClasses.has(name)) problems.push(`${entry.name} credential ${name} does not resolve`)
            }
            const hidden = skip.has(String(instance.category))
            const legacy = instance.badge === 'DEPRECATING'
            if (hidden && entry.tier !== 'hidden') problems.push(`${entry.name} is in a skipped category but tier is ${entry.tier}`)
            if (!hidden && entry.tier === 'hidden') problems.push(`${entry.name} is hidden but its category is loaded`)
            if (!hidden && legacy && entry.tier !== 'legacy')
                problems.push(`${entry.name} carries the DEPRECATING badge but tier is ${entry.tier}`)
            if (entry.tier === 'legacy' && !legacy) problems.push(`${entry.name} is legacy without the DEPRECATING badge`)
            if ((entry.tier === 'core' || entry.tier === 'supported') && (hidden || legacy))
                problems.push(`${entry.name} tier ${entry.tier} disagrees with its badge or category`)

            const source = fs.readFileSync(abs, 'utf8')
            const reason = initSkipReason(instance, source)
            if (reason) {
                skips.push({ name: entry.name, reason })
                continue
            }
            const before = outbound.length
            try {
                const inputs: Record<string, unknown> = {}
                sampleInputs(instance.inputs, inputs)
                const nodeData = {
                    id: 'load-coverage',
                    label: instance.label,
                    name: instance.name,
                    type: instance.type,
                    icon: instance.icon,
                    version: instance.version,
                    category: instance.category,
                    baseClasses: instance.baseClasses || [],
                    inputs
                }
                let timer: ReturnType<typeof setTimeout> | undefined
                try {
                    await Promise.race([
                        Promise.resolve(instance.init(nodeData, 'load-test', initOptions)),
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new Error('init timed out')), 2000)
                        })
                    ])
                } finally {
                    if (timer) clearTimeout(timer)
                }
                if (outbound.length !== before) problems.push(`${entry.name} called the network during init`)
                else inited.push(entry.name)
            } catch (error) {
                const message = (error as Error).message
                if ((error as NodeJS.ErrnoException).code === 'OUTBOUND_BLOCKED' || outbound.length !== before)
                    problems.push(`${entry.name} called the network during init: ${message}`)
                else if (message.includes('experimental-vm-modules'))
                    skips.push({ name: entry.name, reason: 'init imports an ES module the test runner cannot load' })
                else problems.push(`${entry.name} init failed: ${message}`)
            }
        }

        for (const name of TIER_NAMES) {
            if (catalog.tiers?.[name] !== tierTotals[name as keyof typeof tierTotals])
                problems.push(`tier total ${name} is ${catalog.tiers?.[name]}, counted ${tierTotals[name as keyof typeof tierTotals]}`)
        }
        const loaded = entries.length - problems.filter((line) => line.includes('failed to load')).length
        if (inited.length + skips.length !== loaded)
            problems.push(`inited ${inited.length} plus skipped ${skips.length} is not loaded ${loaded}`)
        if (!inited.includes('calculator')) problems.push('calculator init was not called')
        if (!inited.includes('recursiveCharacterTextSplitter')) problems.push('text splitter init was not called')
        if (!inited.includes('promptTemplate')) problems.push('prompt template init was not called')
        if (outbound.length) problems.push(`outbound calls: ${outbound.join(', ')}`)

        const elapsed = Date.now() - started
        const skipCounts = new Map<string, number>()
        for (const skipEntry of skips) skipCounts.set(skipEntry.reason, (skipCounts.get(skipEntry.reason) || 0) + 1)
        const skipSummary = [...skipCounts.entries()].map(([reason, count]) => `${reason}=${count}`).join(', ')
        const summary = `loaded ${loaded} nodes, ${credentialClasses.size} credentials, inited ${inited.length}, skipped ${skips.length} (${skipSummary}), outbound ${outbound.length}, ${elapsed}ms, tiers core=${tierTotals.core} supported=${tierTotals.supported} legacy=${tierTotals.legacy} hidden=${tierTotals.hidden}`
        const broadSkips = skips.filter((entry) => entry.reason === BROAD_INIT_SKIP).map((entry) => entry.name)
        process.stdout.write(`${summary}\n`)
        process.stdout.write(`broad skips (${BROAD_INIT_SKIP}=${broadSkips.length}): ${broadSkips.join(', ')}\n`)
        // Instrumentation dominates the clock, so a coverage run still has to load
        // every class and still fails on `problems`, but it does not fail the budget.
        if (coverageInstrumentationOn()) {
            process.stdout.write(`time budget not enforced under coverage; elapsed ${elapsed}ms\n`)
            expect({ problems, summary }).toEqual({ problems: [], summary })
            return
        }
        expect({ problems, elapsedUnder60s: elapsed < LOAD_BUDGET_MS, summary }).toEqual({
            problems: [],
            elapsedUnder60s: true,
            summary
        })
    })
})
