import assert from 'node:assert/strict'
import { it } from 'node:test'
import { tableRowOrder } from '../src/tables.js'

it('sorts currency numerically, keeps ties stable and unknowns last in both directions', () => {
    const rows = [['$10,000.00'], ['Unknown'], ['$900.00'], ['($20.00)'], ['$900.00']]
    assert.deepEqual(tableRowOrder(rows, 0, 'ascending', 'ACV'), [3, 2, 4, 0, 1])
    assert.deepEqual(tableRowOrder(rows, 0, 'descending', 'ACV'), [0, 2, 4, 3, 1])
    assert.equal(rows[0][0], '$10,000.00')
})

it('sorts percentages, dates, risk categories and names by their displayed meaning', () => {
    assert.deepEqual(tableRowOrder([['9%'], ['80%'], ['N/A']], 0, 'descending'), [1, 0, 2])
    assert.deepEqual(tableRowOrder([['Dec 1, 2026'], ['Jan 2, 2027'], ['Unknown']], 0, 'ascending', 'Renewal date'), [0, 1, 2])
    assert.deepEqual(
        tableRowOrder([['Slight Risk'], ['High Risk'], ['Moderate Risk'], ['Unknown']], 0, 'descending', 'Recorded risk'),
        [1, 2, 0, 3]
    )
    assert.deepEqual(tableRowOrder([['account 10'], ['Account 2'], ['account 1']], 0), [2, 1, 0])
})

it('retains exact identifier ordering instead of rounding long numeric IDs', () => {
    assert.deepEqual(tableRowOrder([['9007199254740993'], ['9007199254740992']], 0, 'ascending', 'Account ID'), [1, 0])
})

it('reads currency codes and symbols before or after the amount, with any spacing', () => {
    const rows = [['300 usd'], ['USD 20'], ['10\u00a0€'], ['€ 5'], ['\u2212$1'], ['40\t\tINR'], ['7\u{11FDD}']]
    assert.deepEqual(tableRowOrder(rows, 0, 'ascending', 'Amount'), [4, 3, 6, 2, 1, 5, 0])
    // A partial or non-ASCII code is not a currency code, so the column falls back to text order.
    assert.deepEqual(tableRowOrder([['1.5 US'], ['1.25 USD']], 0, 'ascending', 'Amount'), [0, 1])
    assert.deepEqual(tableRowOrder([['1.5 \u0131nr'], ['1.25 INR']], 0, 'ascending', 'Amount'), [0, 1])
    assert.deepEqual(tableRowOrder([['1.5 inr'], ['1.25 INR']], 0, 'ascending', 'Amount'), [1, 0])
})

it('parses long cells in linear time', () => {
    const long = `1${'\t'.repeat(50000)}x`
    const started = performance.now()
    assert.deepEqual(tableRowOrder([[long], ['2'], [`3${' '.repeat(50000)}€`]], 0, 'descending', 'Amount'), [2, 1, 0])
    assert.ok(performance.now() - started < 250)
})
