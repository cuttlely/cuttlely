import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inlineRowTotal } from './inline-row-total.mjs'
import { openNativeNumericCode } from './native-numeric-code.mjs'

const plain =
    'Using the saved Python tool, collect the units from shipment rows with values 9, -4, 9 and print their total and the row count.'
const table = 'Sum units and count the rows in this inline table: [{"lot":1,"units":9},{"lot":2,"units":-4},{"lot":3,"units":9}]'
const source = 'rows = [{"units":9},{"units":-4},{"units":9}]\ncounts = [row["units"] for row in rows]\nprint(sum(counts), len(rows))'

test('only closed requests declare scalar operands and a projection', () => {
    const expected = { field: 'units', values: [9, -4, 9], output: '14 3\n', summary: '14 units from 3 rows.' }
    assert.deepEqual(inlineRowTotal(plain), expected)
    assert.deepEqual(inlineRowTotal(table), expected)
    assert.deepEqual(inlineRowTotal(table.replace('"lot":1', '"SKU":"B-12","Shipment ID":"A 1","late":false')), expected)
    assert.equal(inlineRowTotal(table.replace('"lot":1', '"lot":{"nested":1}')), undefined)
    const reversed = 'Here are the rows: [{"units":9},{"units":-4},{"units":9}]. How many rows are there, and what is the total for units?'
    assert.deepEqual(inlineRowTotal(reversed), expected)
    assert.equal(inlineRowTotal(reversed + ' Compare that with our verified report.'), undefined)
    assert.equal(inlineRowTotal(reversed.replace('Here are the rows', 'Fetch the rows')), undefined)
    assert.equal(
        inlineRowTotal(reversed.replace('and what is the total for units', 'and fetch the total for units from our database')),
        undefined
    )
    for (const value of [
        plain + ' Then look up our database.',
        'Based on payroll, ' + plain,
        plain.replace('shipment rows', 'database rows'),
        plain + ' Verify this against the saved report.',
        table + ' Consult the original report.',
        table.replace('"units":9', '"units":"9"'),
        table.replace('{"lot":1', '{"unit$":1'),
        table.replace('9', '9007199254740992'),
        plain.replace('9, -4, 9', '9,,3'),
        'Sum units and count the rows in this inline table: []'
    ]) {
        assert.equal(inlineRowTotal(value), undefined)
    }
})
test('independent whole-turn evidence checks actual projected operands, count source, and stdout', async () => {
    const input = inlineRowTotal(table)
    async function observe(code, claim = input) {
        const api = openNativeNumericCode({ codeExecution: true }, 'on-demand', undefined, undefined, claim)
        const packet = JSON.parse(await api.execute('execute_code', { code }))
        assert.equal(packet.status, 'success')
        assert.equal('confirmedInlineTotal' in packet, false)
        return { output: packet.output, proof: api.confirmedInlineTotal() }
    }
    assert.deepEqual(await observe(source), { output: '14 3\n', proof: input.summary })
    for (const code of [
        source.replaceAll('9}', '8}').replace('-4}', '-2}'), // same sum and count, different operands
        source.replace('print(sum(counts), len(rows))', 'print(14, 3)'),
        source.replace('print(sum(counts), len(rows))', 'print("unrelated")\nprint(sum(counts), len(rows))'),
        source.replace('print(sum(counts), len(rows))', 'alt = [{"units":7},{"units":-2},{"units":9}]\nprint(sum(counts), len(alt))')
    ])
        assert.equal((await observe(code)).proof, undefined)
    assert.equal((await observe(source, null)).proof, undefined)
})

test('locals and either output order retain evidence only for the supplied operands', async () => {
    const claim = inlineRowTotal(table)
    async function proof(tail) {
        const api = openNativeNumericCode({ codeExecution: true }, 'on-demand', undefined, undefined, claim)
        const code = source.slice(0, source.lastIndexOf('print(')) + tail
        const packet = JSON.parse(await api.execute('execute_code', { code }))
        assert.equal(packet.status, 'success')
        return api.confirmedInlineTotal()
    }
    assert.equal(await proof('print(sum(counts), len(counts))'), claim.summary)
    assert.equal(await proof('total = sum(counts)\nn = len(rows)\nanswer = total\nprint(n, answer)'), claim.summary)
    assert.equal(await proof('other = [8,-2,8]\ntotal = sum(other)\nn = len(rows)\nprint(total, n)'), undefined)
    assert.equal(await proof('total = sum(counts)\nn = len(rows)\ntotal = 14\nprint(total, n)'), undefined)
    assert.equal(await proof('n = len(rows)\ncounts = [8,-2,8]\ntotal = sum(counts)\nprint(n, total)'), undefined)
})
