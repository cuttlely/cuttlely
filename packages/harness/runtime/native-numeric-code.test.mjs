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
