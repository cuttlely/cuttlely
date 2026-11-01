import assert from 'node:assert/strict'
import test from 'node:test'
import { routeAnalystNote, sharedAnalystSources, ROUTE_ANALYSTS } from './run.mjs'

const role = (name, nodeId, extra = {}) => ({ name, modules: [{ nodeName: 'postgreSQLMCP', nodeId, ...extra }] })

test('the router groups explicitly shared query scopes without exposing binding identity or credentials', () => {
    const specialists = [
        role('data', 'private-node', { credential: 'private-credential' }),
        role('files', 'private-node'),
        role('support', 'other-node')
    ]
    const note = sharedAnalystSources(specialists)
    assert(note.includes('"data", "files"'))
    assert(!note.includes('support'))
    assert(!note.includes('private-node'))
    assert(!note.includes('private-credential'))
    assert(routeAnalystNote(specialists).startsWith(ROUTE_ANALYSTS))
    assert(routeAnalystNote(specialists).includes(note))
})

test('missing identity, similar labels and shared credentials never certify a shared source scope', () => {
    assert.equal(sharedAnalystSources([role('a', ''), role('b', '')]), '')
    assert.equal(sharedAnalystSources([role('a', 'a', { credential: 'same' }), role('b', 'b', { credential: 'same' })]), '')
    assert.equal(sharedAnalystSources([{ name: 'a', modules: [{ nodeName: 'other', nodeId: 'same' }] }, role('b', 'same')]), '')
})

test('duplicate module/MCP references do not create duplicate owners or extra source groups', () => {
    const a = role('a', 'shared')
    a.mcpServers = [...a.modules]
    assert.equal(sharedAnalystSources([a]), '')
    assert.equal(sharedAnalystSources([a, role('b', 'shared')]).match(/Source \d+:/g).length, 1)
})
