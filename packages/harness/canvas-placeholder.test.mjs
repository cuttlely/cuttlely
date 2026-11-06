import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { harnessCanvasCanWaitForRoster, harnessCanvasIsPlaceholder } from './sync-from-flow.mjs'

const chief = { id: 'chief', data: { name: 'harnessChief' } }

test('an empty canvas is a placeholder and is not written as a harness file', () => {
    assert.equal(harnessCanvasIsPlaceholder(''), true)
    assert.equal(harnessCanvasIsPlaceholder('{"nodes":[],"edges":[]}'), true)
    assert.equal(harnessCanvasIsPlaceholder({ nodes: [{ id: 'note', data: { name: 'stickyNote' } }], edges: [] }), true)
})

test('a canvas with a Harness Prime or a specialist is not a placeholder', () => {
    assert.equal(harnessCanvasIsPlaceholder(JSON.stringify({ nodes: [chief], edges: [] })), false)
    assert.equal(harnessCanvasIsPlaceholder({ nodes: [{ id: 'spec', data: { name: 'harnessSpecialist' } }], edges: [] }), false)
})

test('unreadable canvas JSON is not treated as a placeholder', () => {
    assert.equal(harnessCanvasIsPlaceholder('{'), false)
})

test('a readable canvas can wait for its roster before a harness file exists', () => {
    const name = `ZZ-TEST-waiting-${process.pid}`
    assert.equal(harnessCanvasCanWaitForRoster({ name, flowData: { nodes: [chief], edges: [] } }), true)
    assert.equal(harnessCanvasCanWaitForRoster({ name, flowData: '{' }), false)
})

test('an empty canvas cannot wait over an existing harness file and leaves its roster untouched', () => {
    const previous = process.env.CUTTLELY_DATA_DIR
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-placeholder-'))
    process.env.CUTTLELY_DATA_DIR = dir
    try {
        const name = 'live-team'
        const flowData = { nodes: [], edges: [] }
        assert.equal(harnessCanvasCanWaitForRoster({ name, flowData }), true)
        fs.mkdirSync(path.join(dir, 'harnesses'))
        const file = path.join(dir, 'harnesses', `${name}.json`)
        const roster = JSON.stringify({ name, workspaceId: 'team-a', chatflowId: 'flow-1', specialists: [{ name: 'researcher' }] })
        fs.writeFileSync(file, roster)
        assert.equal(harnessCanvasCanWaitForRoster({ name, flowData }), false)
        assert.equal(fs.readFileSync(file, 'utf8'), roster)
    } finally {
        if (previous === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previous
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
