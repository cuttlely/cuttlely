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
