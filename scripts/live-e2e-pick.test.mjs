import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickCases } from './live-e2e/pick.mjs'

const cases = [{ canvas: 'chat flow' }, { canvas: 'harness' }, { canvas: 'document store' }]

test('no list runs every case', () => {
    assert.deepEqual(pickCases(cases, ''), cases)
    assert.deepEqual(pickCases(cases, undefined), cases)
    assert.deepEqual(pickCases(cases, ' , '), cases)
})

test('names match without regard to case or spaces', () => {
    assert.deepEqual(pickCases(cases, ' Document Store ,harness'), [cases[1], cases[2]])
})

test('a name that matches no case stops the run instead of checking nothing', () => {
    assert.throws(() => pickCases(cases, 'document-store'), /No case named "document-store"\. Known: chat flow, harness, document store/)
    assert.throws(() => pickCases(cases, 'harness,workflw'), /"workflw"/)
})

test('another name field can be used', () => {
    const files = [{ file: 'a.json' }, { file: 'b.json' }]
    assert.deepEqual(
        pickCases(files, 'B.JSON', (item) => item.file),
        [files[1]]
    )
})
