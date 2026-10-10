import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
    DEFAULT_FIXTURE,
    compareFlow,
    compareNames,
    compareVersions,
    fixtureProblems,
    nodeCount,
    readFixture,
    versionList
} from './upgrade-check.mjs'

test('the bundled fixture is complete and laid out like the Docker volume', () => {
    const { meta, archive } = readFixture(DEFAULT_FIXTURE)
    assert.deepEqual(fixtureProblems(meta), [])
    const types = meta.expected.flows.map((f) => f.type).sort()
    assert.deepEqual(types, ['AGENTFLOW', 'CHATFLOW', 'HARNESS'])
    assert.ok(
        meta.expected.flows.some((f) => f.predict && f.versions.length >= 2),
        'a chatflow with at least two versions that the check can predict on'
    )
    assert.ok(meta.expected.harnesses[0].specialists.length >= 2)
    assert.equal(meta.expected.credentials[0].name, 'Bakery OpenAI')
    const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(list.status, 0, list.stderr)
    for (const entry of [
        './data/database.sqlite',
        './data/encryption.key',
        './versions/.git/HEAD',
        `./harnesses/${meta.expected.harnesses[0].name}.json`
    ]) {
        assert.ok(list.stdout.split('\n').includes(entry), entry)
    }
    assert.ok(!list.stdout.includes('database.sqlite-wal'), 'the database is checkpointed')
})

test('fixtureProblems names what is missing', () => {
    assert.deepEqual(fixtureProblems({}).length > 0, true)
    const ok = {
        baseline: { commit: 'abcdef1' },
        account: { email: 'a@example.com', password: 'x' },
        expected: { flows: [{ id: '1', name: 'n', type: 'CHATFLOW', versions: [] }], credentials: [{ id: 'c', name: 'C' }], harnesses: [] }
    }
    assert.deepEqual(fixtureProblems(ok), [])
    assert.match(fixtureProblems({ ...ok, expected: { ...ok.expected, flows: [] } }).join(), /flows is empty/)
})

test('comparisons report a lost flow, a renamed flow, lost cards, lost versions and lost names', () => {
    const flow = { id: '1', name: 'Bakery helper', type: 'CHATFLOW', nodes: 3, versions: ['a', 'b'] }
    const flowData = JSON.stringify({ nodes: [{}, {}, {}], edges: [] })
    assert.deepEqual(compareFlow(flow, { name: 'Bakery helper', type: 'CHATFLOW', flowData }), [])
    assert.match(compareFlow(flow, null)[0], /is gone/)
    assert.match(compareFlow(flow, { name: 'Other', type: 'CHATFLOW', flowData }).join(), /is named Other/)
    assert.match(compareFlow(flow, { name: 'Bakery helper', type: 'CHATFLOW', flowData: '{"nodes":[]}' }).join(), /0 cards, expected 3/)
    assert.deepEqual(compareVersions(flow, [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }]), [])
    assert.match(compareVersions(flow, [{ sha: 'a' }]).join(), /lost 1 of 2/)
    assert.deepEqual(compareNames('credential', ['A', 'B'], ['B', 'A', 'C']), [])
    assert.deepEqual(compareNames('credential', ['A', 'B'], ['B']), ['credential A is gone'])
    assert.equal(nodeCount('not json'), null)
    assert.deepEqual(versionList({ json: { versions: [{ sha: 'x' }] } }), [{ sha: 'x' }])
    assert.deepEqual(versionList({ json: [{ sha: 'y' }] }), [{ sha: 'y' }])
    assert.deepEqual(versionList({ json: null }), [])
})
