import assert from 'node:assert/strict'
import test from 'node:test'
import { harnessCanvasIsPlaceholder } from './sync-from-flow.mjs'

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
