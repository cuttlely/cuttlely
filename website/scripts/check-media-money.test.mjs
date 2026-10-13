import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineHasMoney, moneyIn, scanMedia } from './check-media-money.mjs'

const positives = [
    'Price | $ | 25.20',
    'twenty-five dollars and twenty cents',
    'Total $25',
    '$ 25.20',
    '10 dollars',
    'two euros',
    'five pounds',
    '20 cents',
    '£ 10',
    '€20',
    '$1,234',
    '£1,000',
    '$5',
    '$1000',
    '$0.00',
    '$ 1,000',
    '$12,345'
]

const negatives = [
    '3 items',
    '1.3 s',
    '3.7x',
    '2,114',
    'five items',
    '0.8 s',
    'A price question',
    'median of 5 runs',
    'b$58-6537',
    '$3d2-484e',
    'a pound of flour',
    'a dollar bill',
    '$33,out',
    '$541 in'
]

test('currency matcher flags amounts and leaves plain figures alone', () => {
    for (const line of positives) assert.equal(lineHasMoney(line), true, line)
    for (const line of negatives) assert.equal(lineHasMoney(line), false, line)
})

test('a symbol split from its amount is a hit once the OCR line is joined', () => {
    const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
    const word = (n, text) => `5\t1\t1\t1\t1\t${n}\t${n * 20}\t0\t10\t10\t90\t${text}`
    const tsv = [header, word(1, 'Price'), word(2, '|'), word(3, '$'), word(4, '|'), word(5, '25.20')].join('\n')
    assert.deepEqual(moneyIn(tsv), ['Price | $ | 25.20'])
    const plain = [header, word(1, '3'), word(2, 'items')].join('\n')
    assert.deepEqual(moneyIn(plain), [])
    const row = (n, text, conf) => `5\t1\t1\t1\t1\t${n}\t${n * 20}\t0\t10\t10\t${conf}\t${text}`
    assert.deepEqual(moneyIn([header, row(1, '$25', 60)].join('\n')), ['$25'])
    assert.deepEqual(moneyIn([header, row(1, 'twenty dollars', 55)].join('\n')), ['twenty dollars'])
    assert.deepEqual(moneyIn([header, row(1, ':s£', 60)].join('\n')), [])
    assert.deepEqual(moneyIn([header, row(1, '$33', 74), row(2, 'out', 90)].join('\n')), [])
    assert.deepEqual(moneyIn([header, row(1, '$1384', 70)].join('\n')), [])
    assert.deepEqual(moneyIn([header, row(1, '$541', 29)].join('\n')), [])
    assert.deepEqual(moneyIn([header, row(1, '$81', 56)].join('\n')), [])
    assert.deepEqual(moneyIn([header, row(1, '$81', 60)].join('\n')), ['$81'])
    assert.deepEqual(moneyIn([header, row(1, '$33,out', 28)].join('\n')), [])
    assert.deepEqual(moneyIn([header, row(1, '$25.20', 40)].join('\n')), ['$25.20'])
    assert.deepEqual(moneyIn([header, row(1, '$100', 84)].join('\n')), [])
    assert.deepEqual(moneyIn([header, row(1, '$100', 85)].join('\n')), ['$100'])
    assert.deepEqual(moneyIn([header, row(1, '$5', 90)].join('\n')), ['$5'])
    assert.deepEqual(moneyIn([header, row(1, '$0.00', 40)].join('\n')), ['$0.00'])
})

test('homepage media shows no currency amount', async () => {
    const result = await scanMedia()
    if (result.skipped) {
        console.log(result.skipped)
        return
    }
    assert.deepEqual(result.hits, [], result.hits.map((hit) => `${hit.file} @ ${hit.at}: ${hit.text}`).join('\n'))
})
