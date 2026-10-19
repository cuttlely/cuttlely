import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const A2A_API_URL = 'https://YOUR_HOST/api/v1/a2a/YOUR_FLOW_ID'
const SENSITIVE_KEYS = new Set(['token', 'apikey', 'api_key', 'password', 'secret', 'authorization', 'xaiapikey', 'credential'])
const PLACEHOLDER = /^(?:<[^>]+>|YOUR_[A-Z0-9_]+|REPLACE_[A-Z0-9_]+|replace-me|)$/i

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function unquote(value) {
    const trimmed = value.trim()
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
        return trimmed.slice(1, -1)
    }
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    return trimmed
}

function yamlMap(text) {
    const root = {}
    const stack = [{ indent: -1, node: root }]
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\t/g, '    ')
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const indent = line.match(/^ */)[0].length
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
        const parent = stack[stack.length - 1].node
        if (trimmed.startsWith('- ')) {
            if (!Array.isArray(parent.items)) parent.items = []
            parent.items.push(unquote(trimmed.slice(2)))
            continue
        }
        const colon = trimmed.indexOf(':')
        assert.ok(colon > 0, `yaml line: ${trimmed}`)
        const key = trimmed.slice(0, colon).trim()
        const rest = trimmed.slice(colon + 1)
        if (rest.trim() === '') {
            const child = {}
            parent[key] = child
            stack.push({ indent, node: child })
        } else {
            parent[key] = unquote(rest)
        }
    }
    return root
}

function isSensitiveKey(key) {
    return SENSITIVE_KEYS.has(String(key).toLowerCase())
}

function looksSecret(value) {
    if (typeof value !== 'string') return typeof value === 'number' && Number.isFinite(value)
    const trimmed = value.trim()
    if (PLACEHOLDER.test(trimmed)) return false
    const skPrefix = ['sk', '-'].join('')
    if (new RegExp('^' + skPrefix + '[A-Za-z0-9_-]+').test(trimmed)) return true
    if (/^[0-9a-f]{32,}$/i.test(trimmed)) return true
    return trimmed.length > 0
}

function scanNamedFields(value, trail = '', hits = []) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => scanNamedFields(item, `${trail}[${index}]`, hits))
        return hits
    }
    if (!value || typeof value !== 'object') return hits
    for (const [key, child] of Object.entries(value)) {
        const next = trail ? `${trail}.${key}` : key
        if (isSensitiveKey(key) && looksSecret(child)) hits.push({ path: next, value: child })
        scanNamedFields(child, next, hits)
    }
    return hits
}

describe('orchestrate samples', () => {
    it('the demo chatflow is Grok plus Buffer Memory, matched by data.name, with no credential', () => {
        const flow = JSON.parse(read('samples/orchestrate/demo.chatflow.json'))
        assert.equal(flow.name, 'Harbor bakery hours')
        assert.equal(flow.description, 'Cuttlely chatflow Harbor bakery hours')
        const graph = JSON.parse(flow.flowData)
        const byName = new Map(graph.nodes.map((node) => [node.data.name, node]))
        assert.ok(byName.has('chatXAI'), 'chatXAI node')
        assert.ok(byName.has('bufferMemory'), 'bufferMemory node')
        assert.ok(byName.has('conversationChain'), 'conversationChain node')
        const grok = byName.get('chatXAI')
        assert.equal(grok.data.inputs.modelName, 'grok-4.7')
        assert.equal(grok.data.credential, undefined)
        assert.equal(grok.data.inputs.xaiApiKey, undefined)
        assert.equal(byName.get('bufferMemory').data.inputs.memoryKey, 'chat_history')
        assert.equal(scanNamedFields(flow).length, 0)
    })

    it('pins the A2A sample api_url and uses the exact agent names', () => {
        const a2a = yamlMap(read('samples/orchestrate/a2a.agent.yaml'))
        assert.equal(a2a.name, 'cuttlely_a2a_test')
        assert.equal(a2a.nickname, 'cuttlely_a2a_test')
        assert.equal(a2a.title, 'Harbor bakery hours')
        assert.equal(String(a2a.description).trim(), 'Cuttlely chatflow Harbor bakery hours')
        assert.equal(a2a.provider, 'external_chat/A2A/0.3.0')
        assert.equal(a2a.api_url, A2A_API_URL)
        assert.equal(a2a.auth_scheme, 'API_KEY')
        assert.equal(a2a.chat_params.pushNotifications, false)
        const external = yamlMap(read('samples/orchestrate/external-chat.agent.yaml'))
        assert.equal(external.name, 'cuttlely_orders')
        assert.equal(external.nickname, 'cuttlely_orders')
        assert.equal(external.title, 'Cuttlely orders')
        assert.equal(external.provider, 'external_chat')
        assert.equal(external.api_url, 'https://YOUR_HOST/api/v1/orchestrate/YOUR_FLOW_ID')
        assert.equal(external.config.enable_cot, false)
    })

    it('key scan checks named fields, not the raw file, and accepts placeholders', () => {
        const files = [
            ['samples/orchestrate/a2a.agent.yaml', yamlMap],
            ['samples/orchestrate/external-chat.agent.yaml', yamlMap],
            ['samples/orchestrate/demo.chatflow.json', JSON.parse]
        ]
        for (const [rel, parse] of files) {
            const raw = read(rel)
            const hits = scanNamedFields(parse(raw))
            assert.deepEqual(hits, [], rel)
            if (rel.endsWith('.yaml')) assert.match(raw, /\btoken\b/)
        }
        assert.deepEqual(scanNamedFields({ auth_config: { token: '<API_KEY>' } }), [])
        assert.deepEqual(scanNamedFields({ auth_config: { token: 'YOUR_API_KEY' } }), [])
        const fakeKey = ['sk', '-live-examplevalue'].join('')
        assert.ok(scanNamedFields({ auth_config: { token: fakeKey } }).length > 0)
        assert.ok(scanNamedFields({ credential: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).length > 0)
        assert.deepEqual(scanNamedFields({ note: 'the token field is a placeholder' }), [])
    })

    it('how-to pages have H1 titles, 500 internal_error, MCP link, copy-not-repo, and shots 7 and 9', () => {
        const how = read('docs/how-to/orchestrate.md')
        const demo = read('docs/how-to/orchestrate-demo.md')
        assert.match(how, /^# /)
        assert.match(demo, /^# /)
        assert.match(how, /internal_error/)
        assert.match(how, /\b500\b/)
        assert.match(how, /api\.md#mcp-endpoint/)
        assert.match(how, /filled-in copy/)
        assert.match(how, /Do not import the files from this repository/)
        assert.match(how, /X-IBM-THREAD-ID/)
        assert.match(how, /contextId/)
        assert.match(how, /accepted only on the Orchestrate routes/)
        assert.match(how, /Do not send it on A2A routes/)
        assert.match(how, /off-screen/)
        assert.match(how, /AI Gateway/)
        assert.match(how, /Agent directory/)
        assert.match(how, /Add agent/)
        assert.match(how, /chat_with_collaborator/)
        assert.match(how, /native/)
        assert.match(how, /cuttlely_orders/)
        assert.match(how, /larkfield_router/)
        assert.match(how, /Open items until the A2A live test/)
        assert.match(how, /A2A registration path/)
        assert.match(how, /resending earlier turns/)
        assert.match(how, /Do not treat either as fact/)
        assert.match(how, /confirmed for `cuttlely_orders` only/)
        assert.doesNotMatch(
            how.split('## A2A 0.3.0 contract')[1].split('## MCP instead of an external agent')[0],
            /In the Orchestrate UI, register the external agent under/
        )
        assert.match(demo, /off-screen/)
        assert.match(demo, /AI Gateway/)
        assert.match(demo, /chat_with_collaborator/)
        assert.match(demo, /before teardown/)
        assert.match(demo, /\[LIVE-TEST\]/)
        assert.match(demo, /cuttlely_orders/)
        assert.match(demo, /larkfield_router/)
        assert.match(demo, /Who records/)
        assert.match(demo, /A2A registration path/)
        assert.match(demo, /resending earlier turns/)
        assert.match(demo, /Do not state either as fact/)
        assert.match(demo, /7\s+\| Request \/ thread header[\s\S]*X-IBM-THREAD-ID/)
        assert.match(demo, /9\s+\| Follow-up in the same thread[\s\S]*X-IBM-THREAD-ID/)
        assert.match(demo, /thread=none/)
        assert.match(demo, /Does not reach A2A/)
        assert.doesNotMatch(how, /!\[[^\]]*\]\([^)]+\)/)
        assert.doesNotMatch(demo, /!\[[^\]]*\]\([^)]+\)/)
        assert.ok(read('docs/README.md').includes('how-to/orchestrate.md'))
        assert.ok(read('docs/README.md').includes('how-to/orchestrate-demo.md'))
        assert.match(read('docs/api.md'), /^## MCP endpoint$/m)
        assert.match(read('.github/workflows/main.yml'), /types: \[opened, synchronize, reopened, ready_for_review, edited\]/)
    })
})
