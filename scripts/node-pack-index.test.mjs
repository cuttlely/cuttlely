// The committed index has to match the pack folders, or a new pack ships without a name.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { INDEX_PATH, buildNodePackIndex, indexText } from './build-node-pack-index.mjs'

test('the committed node pack index matches the pack folders', () => {
    const current = fs.existsSync(INDEX_PATH) ? fs.readFileSync(INDEX_PATH, 'utf8') : ''
    assert.equal(current, indexText(buildNodePackIndex()))
})

test('a pack node name and label point at that pack', () => {
    const index = buildNodePackIndex()
    const row = index.nodes.find((node) => node.name === 'serpAPI')
    assert.ok(row, 'serpAPI is missing from the index')
    assert.equal(row.label, 'Serp API')
    assert.equal(row.pack, '@cuttlely/node-pack-tools-mcp')
    const pinecone = index.nodes.find((node) => node.name === 'pinecone')
    assert.ok(pinecone, 'pinecone is missing from the index')
    assert.equal(pinecone.pack, '@cuttlely/node-pack-vector-stores')
    const names = new Set(index.nodes.map((node) => node.name))
    assert.equal(names.size, index.nodes.length)
})
