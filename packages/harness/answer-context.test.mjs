import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { answerSelections, selectionContext, sourceRecordTables } from './answer-context.mjs'

const source = (rows) => ({ result: { rows }, toolName: 'pq_records', callId: 'server-call' })
const table = (header, rows) =>
    `| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|\n${rows.map((row) => '| ' + row.join(' | ') + ' |').join('\n')}`

test('source-backed selection preserves displayed subset and order across domains and hidden stable keys', () => {
    for (const noun of ['ticket', 'shipment', 'renewal', 'device']) {
        const rows = [3, 1, 2].map((n) => ({ [`${noun}_id`]: `${noun}-${n}`, name: `Item ${n}`, amount: n * 10, password: 'private' }))
        const answer = table(
            ['Name', 'Amount'],
            [
                ['Item 2', 20],
                ['Item 3', 30]
            ]
        )
        const selections = answerSelections(answer, [source(rows)], 'Original scope')
        assert.deepEqual(
            selections[0].records.map((row) => row[`${noun}_id`]),
            [`${noun}-2`, `${noun}-3`]
        )
        assert(!JSON.stringify(selections).includes('amount'))
        assert(!selectionContext(selections).includes('private'))
    }
})

test('complete table packets and encoded cells use exact source keys without inventing membership', () => {
    const packet = {
        headers: ['record_id', 'name'],
        complete_rows: [
            ['B-2', 'B & Co'],
            ['A-1', 'A | Co']
        ]
    }
    const selections = answerSelections(
        table(
            ['ID', 'Name'],
            [
                ['A-1', 'A &#124; Co'],
                ['B-2', 'B & Co']
            ]
        ),
        [source([{ packet: JSON.stringify(packet) }])]
    )
    assert.deepEqual(
        selections[0].records.map((row) => row.record_id),
        ['A-1', 'B-2']
    )
})

test('table envelopes accept header-keyed objects as well as positional arrays and human-readable ID headers', () => {
    for (const headers of [
        ['record_id', 'account_name'],
        ['Record ID', 'Account Name']
    ]) {
        const packet = {
            headers,
            complete_rows: [
                Object.fromEntries([
                    [headers[0], 'R-2'],
                    [headers[1], 'Example']
                ])
            ]
        }
        const selections = answerSelections(table(headers, [['R-2', 'Example']]), [source([{ packet }])])
        assert.equal(selections[0].records[0][headers[0]], 'R-2')
    }
})

test('ambiguous names, grains, fabricated rows and partial source matches never certify a selection', () => {
    const rows = [
        { item_id: 'I-1', name: 'Same' },
        { item_id: 'I-2', name: 'Same' }
    ]
    assert.deepEqual(answerSelections(table(['Name'], [['Same']]), [source(rows)]), [])
    assert.deepEqual(answerSelections(table(['ID'], [['I-1'], ['invented']]), [source(rows)]), [])
    assert.deepEqual(
        answerSelections(table(['Name'], [['Same']]), [
            source([{ account_id: 'A-1', name: 'Same' }]),
            source([{ project_id: 'P-1', name: 'Same' }])
        ]),
        []
    )
    assert.deepEqual(answerSelections('The best option is I-1.', [source(rows)]), [])
})

test('numeric ranking markers cannot be mistaken for a hidden numeric source ID', () => {
    const rows = [
        { id: 1, name: 'One' },
        { id: 2, name: 'Two' }
    ]
    assert.deepEqual(answerSelections(table(['Rank', 'Comment'], [[1, 'Recommended']]), [source(rows)]), [])
    assert.equal(answerSelections(table(['ID'], [[2], [1]]), [source(rows)])[0].records[0].id, 2)
})

test('traversal bounds and private keys apply to nested packets and table headers', () => {
    const tables = sourceRecordTables({
        rows: [{ payload: { headers: ['id', 'access_token', '__proto__'], complete_rows: [['A-1', 'private', 'bad']] } }]
    })
    assert.equal(tables.length, 1)
    assert.deepEqual(tables[0], [{ id: 'A-1' }])
    assert.deepEqual(sourceRecordTables({ rows: Array.from({ length: 1001 }, () => ({ id: 'x' })) }), [])
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-context-'))
process.env.CUTTLELY_DATA_DIR = dir
const { appendTurn, readPromptContext, closeSessions } = await import('./session.mjs')
after(() => {
    closeSessions()
    fs.rmSync(dir, { recursive: true, force: true })
})

test('selection survives clipped history and failed turns, scoped to its harness and chat', () => {
    const selection = answerSelections(table(['ID'], [['A-2'], ['A-1']]), [source([{ id: 'A-1' }, { id: 'A-2' }])])
    appendTurn('team', 'chat', 'Find records', 'x'.repeat(4000), [], selection)
    for (let i = 0; i < 4; i++) appendTurn('team', 'chat', 'Follow up', 'Source unavailable', [], [])
    closeSessions()
    assert.deepEqual(readPromptContext('team', 'chat').selections, selection)
    assert.deepEqual(readPromptContext('team', 'other').selections, [])
    assert.deepEqual(readPromptContext('other-team', 'chat').selections, [])
})
