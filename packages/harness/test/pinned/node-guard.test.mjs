import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { analystCallLimits } from '../../runtime/analyst-store.mjs'
import { parseRelationSelection } from '../../runtime/analyst-relations.mjs'

const require = createRequire(import.meta.url)
const guard = require('../../runtime/node-guard.cjs')
const parity = JSON.parse(fs.readFileSync(new URL('../../../../scripts/fixtures/pinned/guard-parity.json', import.meta.url), 'utf8'))

test('ZZ-TEST-the parity fixture reads to its expected settings and limits', () => {
    const settings = guard.nodeGuardSettings(parity.inputs)
    assert.deepEqual(settings, {
        relations: parity.expected.relations,
        allowedFunctions: parity.expected.allowedFunctions,
        stampFunctions: parity.expected.stampFunctions,
        requested: parity.expected.requested
    })
    assert.deepEqual(analystCallLimits(settings.requested, {}), parity.expected.limits)
    const capped = guard.nodeGuardSettings(parity.inputs, { rowCap: parity.pin.rowCap })
    assert.deepEqual(capped.requested, parity.pin.requested)
    assert.deepEqual(analystCallLimits(capped.requested, {}), parity.pin.limits)
})

test('ZZ-TEST-analyst-relations re-exports the one relation parser', () => {
    assert.equal(parseRelationSelection, guard.parseRelationSelection)
    assert.deepEqual(parseRelationSelection('["public.demo_sales","public.demo_sales"]'), ['public.demo_sales'])
    assert.deepEqual(parseRelationSelection(' public.demo_sales ,, public.demo_regions '), ['public.demo_sales', 'public.demo_regions'])
    assert.deepEqual(parseRelationSelection('choose an option'), [])
    assert.deepEqual(parseRelationSelection(''), [])
    assert.deepEqual(parseRelationSelection({}), [])
})

test('ZZ-TEST-a templated function list is ignored whole', () => {
    for (const value of ['public.lower(text)\n{{secret}}', 'public.lower($vars.fn)', '$flow.state', 42, null]) {
        const settings = guard.nodeGuardSettings({ analystAllowedFunctions: value })
        assert.equal(settings.allowedFunctions, '')
        assert.deepEqual(settings.stampFunctions, [])
    }
    assert.deepEqual(guard.nodeGuardSettings({ analystAllowedFunctions: 'public.lower(text)\n# note' }).stampFunctions, [
        'public.lower(text)',
        '# note'
    ])
})

test('ZZ-TEST-row cap and timeout: blanks and non-positive values fall back, a pin cap only lowers', () => {
    for (const value of ['', ' ', '0', '-3', 'abc', null, undefined]) {
        assert.deepEqual(guard.nodeGuardSettings({ analystRowCap: value, analystTimeoutSeconds: value }).requested, {
            rowCap: undefined,
            statementTimeoutMs: undefined
        })
    }
    assert.equal(guard.nodeGuardSettings({ analystRowCap: '10' }, { rowCap: 50 }).requested.rowCap, 10)
    assert.equal(guard.nodeGuardSettings({ analystRowCap: '10' }, { rowCap: 4 }).requested.rowCap, 4)
    assert.equal(guard.nodeGuardSettings({}, { rowCap: 4 }).requested.rowCap, 4)
    assert.equal(guard.nodeGuardSettings({ analystRowCap: '10' }, { rowCap: 0 }).requested.rowCap, 10)
})

test('ZZ-TEST-saved pins: JSON text or an array of objects; anything else is invalid', () => {
    assert.deepEqual(guard.readPinnedEntries(''), { entries: [], invalid: false })
    assert.deepEqual(guard.readPinnedEntries(null), { entries: [], invalid: false })
    assert.deepEqual(guard.readPinnedEntries('[{"name":"pq_a"},1,[2],null]'), { entries: [{ name: 'pq_a' }], invalid: false })
    assert.deepEqual(guard.readPinnedEntries('{not json'), { entries: [], invalid: true })
    assert.deepEqual(guard.readPinnedEntries({ name: 'pq_a' }), { entries: [], invalid: true })
})
