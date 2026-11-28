import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openNativeNumericCode } from './native-numeric-code.mjs'

const role = { codeExecution: true }
const tool = openNativeNumericCode(role, 'on-demand')
const sum = (code) => JSON.parse(tool.execute('execute_code', { code }))
const reject = (fn) => assert.throws(fn, (e) => e.code === 'native_unsupported' && !e.message.includes('private-case'))

test('only an on-demand saved code role can use literal integer collections', () => {
    for (const [r, policy] of [
        [role, 'strict'],
        [{}, 'on-demand'],
        [{ ...role, browser: true }, 'on-demand'],
        [{ ...role, shell: true }, 'on-demand']
    ])
        assert.equal(openNativeNumericCode(r, policy), null)
    assert.equal(tool.tools.length, 1)
    assert.equal(tool.tools[0].function.name, 'execute_code')
    assert.deepEqual(tool.tools[0].function.parameters.required, ['code'])
    assert.match(tool.tools[0].function.description, /stateless/)
})

test('released integer stdout and accounting survive empty lists, signs, duplicates and integers above Number precision', () => {
    for (const [code, expected] of [
        ['print(sum([125, 250, 476]))', '851'],
        ['print(sum([]))', '0'],
        ['print(sum([-100, +4, -1, -1,]))', '-98'],
        ['print ( sum ( [9007199254740993, 2] ) )\n', '9007199254740995'],
        ['print(sum([' + ('9'.repeat(64) + ',').repeat(10) + ']))', (BigInt('9'.repeat(64)) * 10n).toString()],
        ['print(sum([' + Array(128).fill('1').join(',') + ']))', '128']
    ]) {
        tool.validate('execute_code', { code })
        const packet = sum(code)
        assert.equal(packet.output, expected + '\n')
        assert.equal(packet.status, 'success')
        assert.equal(packet.exit_code, 0)
        assert.equal(packet.kernel.mode, 'stateless')
        assert.equal(packet.tool_calls_made, 0)
        assert.equal(packet.stdout_bytes_total, Buffer.byteLength(packet.output))
        assert.equal(packet.stdout_bytes_captured, packet.stdout_bytes_total)
        assert.equal(packet.stdout_bytes_omitted, 0)
        assert.equal(packet.stdout_truncated, false)
    }
})

test('out-of-subset source and arguments fail at validation and at execution without disclosing content', () => {
    for (const code of [
        'private-case',
        'print(sum([private-case]))',
        'print(sum([1.25]))',
        'print(sum([2 * 3]))',
        'print(sum([,]))',
        'print(sum([1,,]))',
        'print(sum([01]))',
        'print(sum([1]))\nprint(2)',
        'print(sum([1]))\u2028',
        'print(sum([' + '0'.repeat(65) + ']))',
        'print(sum([' + '9'.repeat(65) + ']))',
        'print(sum([' + Array(129).fill('1').join(',') + ']))',
        'print(sum([' + ' '.repeat(8192) + ']))'
    ])
        for (const method of ['validate', 'execute']) reject(() => tool[method]('execute_code', { code }))
    for (const args of [{}, null, [], { code: 1 }, { code: 'print(sum([]))', reset: true }, { code: 'print(sum([]))', arbitrary: 1 }])
        reject(() => tool.execute('execute_code', args))
    reject(() => tool.execute('unknown', { code: 'print(sum([]))' }))
    assert.equal(JSON.parse(tool.execute('execute_code', { code: 'print(sum([]))', reset: false })).output, '0\n')
})

test('ordinary and empty integer collections produce Python list and aggregate output', () => {
    for (const [op, nonempty, empty] of [
        ['sum', '1', '0'],
        ['len', '3', '0'],
        ['min', '-5'],
        ['max', '3'],
        ['sorted', '[-5, 3, 3]', '[]']
    ]) {
        assert.equal(sum('print(' + op + '([3,-5,3]))').output, nonempty + '\n')
        const result = sum('print(' + op + '([]))')
        if (empty !== undefined) assert.equal(result.output, empty + '\n')
        else {
            assert.equal(result.status, 'error')
            assert.equal(result.exit_code, 1)
            assert.equal(result.error, 'ValueError: ' + op + '() iterable argument is empty')
            assert.equal(result.stdout_bytes_total, 0)
            assert.equal(result.output, '\n--- stderr ---\n' + result.error + '\n')
        }
    }
    assert.equal(sum('print(sorted([9007199254740993, 0, -9007199254740994]))').output, '[-9007199254740994, 0, 9007199254740993]\n')
    reject(() => sum('print(abs([-2]))'))
})

test('ranked literal collection prefixes use Python ordering, signs and list formatting', () => {
    for (const [code, output] of [
        ['print(sorted([25,-7,23,0,24,25], reverse=True)[:5])', '[25, 25, 24, 23, 0]'],
        ['print(sorted([3,-5,3], reverse=True))', '[3, 3, -5]'],
        ['print(sorted([2,5,-9], reverse=False))', '[-9, 2, 5]'],
        ['print(sorted([4,-8,0,3])[:2])', '[-8, 0]'],
        ['print(sorted([4,-8], reverse=True)[:0])', '[]'],
        ['print(sorted([1,-1], reverse=True)[:128])', '[1, -1]'],
        [
            'print(sorted([-9007199254740995, 9007199254740993, 9007199254740992], reverse=True)[:2])',
            '[9007199254740993, 9007199254740992]'
        ],
        ['print(sorted([], reverse=True)[:5])', '[]'],
        ['print( sorted( [2, 1,] , reverse = True ) [ : 1 ] )', '[2]']
    ]) {
        tool.validate('execute_code', { code })
        const packet = sum(code)
        assert.equal(packet.output, output + '\n')
        assert.equal(packet.stdout_bytes_total, Buffer.byteLength(packet.output))
        assert.equal(packet.exit_code, 0)
    }
})

test('the sort accepts only its fixed Boolean direction and bounded literal prefix', () => {
    for (const code of [
        'print(max([1],reverse=True))',
        'print(len([1])[:1])',
        'print(sorted([1],reverse=1))',
        'print(sorted([1],reverse=true))',
        'print(sorted([1],reverse=True,reverse=True))',
        'print(sorted([1], key=abs))',
        'print(sorted([1], key=lambda v: v))',
        'print(sorted([1])[0])',
        'print(sorted([1])[:-2])',
        'print(sorted([1])[:len([1])])',
        'print(sorted([1])[:129])',
        'print(sorted([1])[:1:1])',
        'print(sorted([1])[:01])',
        'print(sorted([1],reverse=True))\nprint(2)'
    ])
        for (const method of ['validate', 'execute']) reject(() => tool[method]('execute_code', { code }))
})

test('native code collects, projects and ranks bounded rows with released Python formatting', async () => {
    const cases = [
        [
            'rows = [{"item":"A", "amount":12}, {"item":"B", "amount":8}]\namounts = []\nfor row in rows:\n    amounts.append(row["amount"])\nprint(sum(amounts), len(rows))',
            '20 2\n'
        ],
        [
            'rows = [(" Beta ",3), ("Alpha",5)]\nreport = []\nfor label, count in rows:\n    report.append((label.strip().lower(), count * 2))\nprint(sorted(report))',
            "[('alpha', 10), ('beta', 6)]\n"
        ],
        [
            'cols = ["item","units"]\nrows = []\nfor pair in [("A", 3), ("B", 7)]:\n    rows.append(dict(zip(cols, pair)))\nprint(rows[1].get("units", 0))',
            '7\n'
        ],
        [
            'totals = {"a":3,"b":7}\nrows = []\nfor name, value in totals.items():\n    rows.extend([name, value])\nprint(rows)',
            "['a', 3, 'b', 7]\n"
        ],
        ['rows = []\nfor i, v in enumerate(["x","y"], 4):\n    rows.append([i,v])\nprint(rows)', "[[4, 'x'], [5, 'y']]\n"],
        ['rows = []\nprint(len(rows))\nprint(max(rows))', '0\n\n--- stderr ---\nValueError: max() iterable argument is empty\n']
    ]
    for (const [code, output] of cases) {
        await tool.validate('execute_code', { code })
        const packet = JSON.parse(await tool.execute('execute_code', { code }))
        assert.equal(packet.output, output)
        assert.equal(packet.status, output.includes('stderr') ? 'error' : 'success')
        assert.equal(packet.stdout_bytes_captured, Buffer.byteLength(output.split('\n--- stderr ---')[0]))
    }
})

test('row validation examines unused branches, enforces limits and isolates concurrent cells', async () => {
    const invalid = [
        'rows=[]\nfor x in rows:\n    import os\nprint(rows)',
        'rows=[]\nfor x in rows:\n    x.clear()\nprint(rows)',
        'rows=[]\nfor x in rows:\n    x = sum([1], [2])\nprint(rows)',
        'rows=[]\nfor x in rows:\n    x = x.items(4)\nprint(rows)',
        'rows=[]\nrows.append(open("private-case"))\nprint(rows)',
        'rows=[]\nprint(rows.__class__)',
        'rows=[]\nwhile rows:\n    rows.append(1)\nprint(rows)',
        'rows=[]\nprint(list(range(1000000000)))',
        'rows=[]\nprint(' + '"x"'.repeat(1025) + ')',
        'rows=[]\nprint(' + '2'.repeat(65) + ')',
        'rows=[]\nprint(enumerate(rows))'
    ]
    for (const code of invalid)
        for (const method of ['validate', 'execute']) {
            await assert.rejects(
                async () => tool[method]('execute_code', { code }),
                (e) => e.code === 'native_unsupported' && !e.message.includes('private-case')
            )
        }
    for (const code of [
        'rows=[]\nrows.append(rows)\nprint(rows)',
        'rows=[1,2]\nfor row in rows:\n    rows.append(1)\nprint(rows)',
        'rows=[1]\nprint(rows * 1000000000)'
    ])
        await assert.rejects(tool.execute('execute_code', { code }), { code: 'native_unsupported' })
    const packets = await Promise.all([3, 18, -5].map((n) => tool.execute('execute_code', { code: 'rows=[' + n + ']\nprint(sum(rows))' })))
    assert.deepEqual(
        packets.map((p) => JSON.parse(p).output),
        ['3\n', '18\n', '-5\n']
    )
    const independent = JSON.parse(await tool.execute('execute_code', { code: 'other=[]\nprint(rows)' }))
    assert.equal(independent.error, "NameError: name 'rows' is not defined")
})

test('concurrent row work is bounded and cancellation frees capacity before dispatch', async () => {
    const code = 'rows=[2, 3]\nprint(sum(rows))'
    const controllers = Array.from({ length: 68 }, () => new AbortController())
    const pending = controllers.map((controller) =>
        openNativeNumericCode(role, 'on-demand', undefined, controller.signal).execute('execute_code', { code })
    )
    const observed = Promise.allSettled(pending)
    const overflow = assert.rejects(tool.execute('execute_code', { code }), { code: 'busy' })
    controllers.forEach((c) => c.abort())
    await overflow
    assert.ok((await observed).every((r) => r.status === 'rejected' && r.reason.name === 'AbortError'))
    const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) => tool.execute('execute_code', { code: 'rows=[' + i + ']\nprint(sum(rows))' }))
    )
    assert.deepEqual(
        results.map((p) => JSON.parse(p).output),
        Array.from({ length: 16 }, (_, i) => i + '\n')
    )
})

test('row aggregation binds just the selected upload and rechecks ownership at validation, read and return', async () => {
    const original = ['item,units', '"Blue, A",5', 'Red,13', ''].join('\r\n')
    const source = 'uploads/units.csv'
    const seen = []
    let revokeAfterRead = false
    const csv = openNativeNumericCode(role, 'on-demand', {
        accepts: () => false,
        csvRows(path, withData) {
            seen.push([path, withData])
            if (path !== source) throw Object.assign(new Error('source unavailable'), { code: 'native_unsupported' })
            if (revokeAfterRead && !withData && seen.some(([, read]) => read))
                throw Object.assign(new Error('changed'), { code: 'harness_changed' })
            if (withData) return { source, data: Buffer.from(original).toString('base64') }
        }
    })
    for (const statement of [
        'rows = list(csv.DictReader(open("uploads/units.csv")))',
        'with open("uploads/units.csv", "r", newline="", encoding="utf-8") as f:\n    rows = list(csv.DictReader(f))'
    ]) {
        const args = {
            code:
                'import csv\n' +
                statement +
                '\ncounts=[]\nfor row in rows:\n    counts.append(int(row["units"]))\nprint(rows[0]["item"], sum(counts))'
        }
        seen.length = 0
        await csv.validate('execute_code', args)
        const result = JSON.parse(await csv.execute('execute_code', args))
        assert.equal(result.output, 'Blue, A 18\n')
        assert.deepEqual(seen, [
            [source, false],
            [source, true],
            [source, false]
        ])
    }
    const code = 'import csv\nrows=list(csv.DictReader(open("uploads/units.csv")))\nprint(len(rows))'
    for (const bad of [
        code.replace('uploads/units.csv', 'uploads/unverified.csv'),
        code.replace('open("uploads/units.csv")', 'open("uploads/units.csv","w")'),
        code.replace('list(csv.DictReader(open("uploads/units.csv")))', 'open("uploads/units.csv").read()'),
        code.replace('print(len(rows))', 'import pathlib\nprint(len(rows))')
    ]) {
        await assert.rejects(csv.validate('execute_code', { code: bad }), { code: 'native_unsupported' })
        await assert.rejects(csv.execute('execute_code', { code: bad }), { code: 'native_unsupported' })
    }
    await assert.rejects(tool.execute('execute_code', { code }), { code: 'native_unsupported' })
    seen.length = 0
    revokeAfterRead = true
    await assert.rejects(csv.execute('execute_code', { code }), { code: 'harness_changed' })
})

test('saved table idioms group rows, filter projected values and preserve local comprehension scope', async () => {
    const examples = [
        [
            'rows=[("North",7),("South",3),("North",12),("South",-1)]\ntotals={}\nfor key,amount in rows:\n    if amount > 0:\n        if key not in totals:\n            totals[key]=0\n        totals[key]+=amount\nprint(totals)',
            "{'North': 19, 'South': 3}\n"
        ],
        ['rows=[{"n":3},{"n":-2},{"n":17}]\nr="outer"\nchosen=[r["n"] for r in rows if 0 < r["n"] < 10]\nprint(chosen,r)', '[3] outer\n'],
        [
            'totals={"north":1,"south":2}\nfor k,v in totals.items():\n    print(k,v)\n    totals["south"]+=1\nprint(sum(totals.values()))',
            'north 1\nsouth 3\n5\n'
        ],
        ['totals={"north":1,"south":2}\nfor k,v in list(totals.items()):\n    print(k,v)\n    totals["south"]+=1', 'north 1\nsouth 2\n'],
        ['rows=[]\nfor i in range(5,0,-2):\n    rows.append("last" if i == 1 else i)\nprint(rows)', "[5, 3, 'last']\n"]
    ]
    for (const [code, result] of examples) {
        await tool.validate('execute_code', { code })
        assert.equal(JSON.parse(await tool.execute('execute_code', { code })).output, result)
    }
    for (const code of [
        'rows=[]\nif rows:\n    import os\nprint(rows)',
        'rows=[]\nprint([r.__class__ for r in rows])',
        'rows=[]\nprint([i for i in rows for j in rows])',
        'rows=[]\nprint([i for i in range(129)])',
        'rows=[]\nrows[0].v=5\nprint(rows)'
    ])
        await assert.rejects(tool.validate('execute_code', { code }), { code: 'native_unsupported' })
})
