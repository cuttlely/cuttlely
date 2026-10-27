import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { getHarness, saveHarness, setHarnessCategory } from '../store.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ZZ-TEST-category-'))
const previousDataDir = process.env.CUTTLELY_DATA_DIR
process.env.CUTTLELY_DATA_DIR = dataDir
after(() => {
    if (previousDataDir === undefined) delete process.env.CUTTLELY_DATA_DIR
    else process.env.CUTTLELY_DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
})

test('category metadata is normalized, bounded, cleared and kept across saves', () => {
    const record = {
        name: 'ZZ-TEST-category',
        chief: { model: { nodeName: 'chatOpenAI' } },
        specialists: [{ name: 'ZZ-TEST-specialist' }]
    }
    const initial = saveHarness(record)
    const saved = setHarnessCategory(record.name, ' sales ; ops; ;sales; ops ')
    assert.equal(saved.category, 'sales;ops')
    assert.equal(saved.updatedAt, initial.updatedAt)
    assert.equal(getHarness(record.name).category, 'sales;ops')
    assert.equal(saveHarness(record, { overwrite: true }).category, 'sales;ops')

    const tags = ['  sales ', '', 'sales', 'x'.repeat(101), 'x'.repeat(100), ...Array.from({ length: 25 }, (_, i) => `tag${i}`)]
    const bounded = setHarnessCategory(record.name, tags)
    assert.deepEqual(bounded.category.split(';'), ['sales', 'x'.repeat(100), ...Array.from({ length: 18 }, (_, i) => `tag${i}`)])
    assert.equal(getHarness(record.name).category, bounded.category)
    assert.equal(Object.hasOwn(setHarnessCategory(record.name, [' ', '']), 'category'), false)
    assert.equal(Object.hasOwn(getHarness(record.name), 'category'), false)
    assert.equal(setHarnessCategory('ZZ-TEST-missing', 'sales'), null)
})
