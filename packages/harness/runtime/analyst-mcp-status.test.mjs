import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    analystOfferCount,
    isAnalystOfferName,
    analystPingHeader,
    analystToolsMissing,
    noteAnalystToolCount,
    readAnalystMcpStatus,
    writeAnalystMcpStatus
} from './analyst-mcp-status.mjs'

const self = fileURLToPath(import.meta.url)

if (process.argv[2] === '--note') {
    const raw = process.argv[3]
    const tools = raw.startsWith('[') ? JSON.parse(raw) : Number(raw)
    noteAnalystToolCount(tools, process.argv[4])
    process.exit(0)
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-analyst-status-'))
}

function noteChild(payload, dir) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [self, '--note', payload, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
        let err = ''
        child.stderr.on('data', (chunk) => {
            err += chunk
        })
        child.on('error', reject)
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`note exited ${code}: ${err}`))
        })
    })
}

test('a query or pinned query counts, and other tools do not', () => {
    assert.equal(analystOfferCount([{ name: 'query' }]), 1)
    assert.equal(analystOfferCount([{ name: 'query' }, { name: 'describe' }]), 1)
    assert.equal(analystOfferCount([{ name: 'query' }, { name: 'pq_sales' }]), 2)
    assert.equal(analystOfferCount(['mcp__analyst__query', 'node__pq_sales']), 2)
    assert.equal(analystOfferCount([{ name: 'describe' }]), 0)
    assert.equal(analystOfferCount([{ name: 'pin_definition' }]), 0)
    assert.equal(analystOfferCount([{ name: 'search_docs' }, { name: 'draft' }]), 0)
    assert.equal(analystOfferCount([{ name: 'xpq_sales' }, { name: 'query_tool' }]), 0)
    assert.equal(analystOfferCount([]), 0)
    assert.equal(analystOfferCount(3), 0)
    assert.equal(analystOfferCount([{ name: '  MCP__Analyst__Query  ' }]), 1)
    assert.equal(isAnalystOfferName('pq_'), false)
    assert.equal(isAnalystOfferName('pq_sales__describe'), true)
    assert.equal(isAnalystOfferName('foo__pq_sales__describe'), true)
    assert.equal(isAnalystOfferName('foo__querybar'), false)
    assert.equal(isAnalystOfferName('mcp__analyst__query_tool'), false)
    assert.equal(isAnalystOfferName('hello world__pq_sales'), true)
    assert.equal(isAnalystOfferName('hello world__pq_sales!'), false)
    const crafted = `pq_${'__pq_'.repeat(4000)}`
    const started = performance.now()
    assert.equal(isAnalystOfferName(`${crafted}!`), false)
    assert.equal(isAnalystOfferName(crafted), true)
    assert.ok(performance.now() - started < 50)
})

test('a later empty or non-analyst list does not clear a recorded offer', () => {
    const dir = tempDir()
    try {
        assert.equal(analystPingHeader(dir), 'unknown')
        assert.equal(analystToolsMissing(dir), false)
        noteAnalystToolCount([], dir)
        assert.equal(readAnalystMcpStatus(dir).tools, 0)
        assert.equal(analystPingHeader(dir), 'missing')
        assert.equal(analystToolsMissing(dir), true)
        noteAnalystToolCount([{ name: 'search_docs' }], dir)
        assert.equal(analystPingHeader(dir), 'missing')
        noteAnalystToolCount([{ name: 'pq_sales' }, { name: 'describe' }], dir)
        assert.equal(readAnalystMcpStatus(dir).tools, 1)
        assert.equal(analystPingHeader(dir), 'ready')
        assert.equal(analystToolsMissing(dir), false)
        noteAnalystToolCount([], dir)
        noteAnalystToolCount([{ name: 'search_docs' }, { name: 'draft' }], dir)
        noteAnalystToolCount(0, dir)
        assert.equal(readAnalystMcpStatus(dir).tools, 1)
        assert.equal(analystPingHeader(dir), 'ready')
        writeAnalystMcpStatus(0, dir)
        assert.equal(analystPingHeader(dir), 'missing')
        noteAnalystToolCount([{ name: 'query' }, { name: 'describe' }], dir)
        assert.equal(readAnalystMcpStatus(dir).tools, 1)
        assert.equal(analystPingHeader(dir), 'ready')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('overlapping lists keep a query offer', async () => {
    const dir = tempDir()
    try {
        for (let round = 0; round < 20; round += 1) {
            fs.rmSync(path.join(dir, 'analyst-mcp.json'), { force: true })
            const other = round % 2 === 0 ? '[]' : JSON.stringify([{ name: 'search_docs' }, { name: 'draft' }])
            await Promise.all([noteChild(JSON.stringify([{ name: 'query' }]), dir), noteChild(other, dir)])
            const status = readAnalystMcpStatus(dir)
            assert.equal(status && status.tools, 1, `round ${round} ${JSON.stringify(status)}`)
            assert.equal(analystPingHeader(dir), 'ready')
            assert.equal(fs.existsSync(path.join(dir, 'analyst-mcp.json.lock')), false)
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
