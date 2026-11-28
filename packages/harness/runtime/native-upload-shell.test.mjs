import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openUploadShell } from './native-upload-shell.mjs'

const file = 'uploads/sales.csv'
const src =
    'item,amount\r\n' +
    Array.from({ length: 19 }, (_, i) => 'item' + String(i + 1).padStart(2, '0') + ',' + (i + 1) * 7 + '\r\n').join('') +
    'last,140'
const role = { shell: true }
function context(body = src, source = file) {
    return {
        checkRole() {},
        managedFileOwner: 'bound-owner',
        checkedUploadFiles: new Set([source]),
        managedUploads: { [source]: Buffer.from(body).toString('base64') },
        assertNativeAuthority() {}
    }
}
test('verified CSV uses the released foreground terminal result shape and preserves CRLF and the unterminated last line', () => {
    const reader = openUploadShell(context(), role)
    for (const [command, output] of [
        ['wc -c', '234 uploads/sales.csv'],
        ['wc -l', '20 uploads/sales.csv'],
        ['wc -lc', '20 234 uploads/sales.csv'],
        ['wc -l -c', '20 234 uploads/sales.csv'],
        ['head -n 2', 'item,amount\r\nitem01,7'],
        ['tail -2', 'item19,133\r\nlast,140']
    ])
        assert.deepEqual(JSON.parse(reader.execute({ command: command + ' ' + file, workdir: '.' })), { output, exit_code: 0, error: null })
    const name = 'uploads/sales east.txt'
    const quoted = openUploadShell(context(src, name), role)
    assert.equal(JSON.parse(quoted.execute({ command: 'wc -l "' + name + '"' })).output, '20 ' + name)
    assert.throws(() => quoted.validate({ command: 'wc -l ' + name }), { code: 'native_unsupported' })
})
test('requires selected on-demand shell and current private receipts; supports one file and one fixed operation', () => {
    const c = context()
    for (const options of [{ checkRole: null }, { replay: true }, { managedFileOwner: null }, { checkedUploadFiles: new Set() }])
        assert.equal(openUploadShell({ ...c, ...options }, role), null)
    for (const options of [
        { shell: false },
        { browser: true },
        { codeExecution: true },
        { fileAccess: true },
        { modules: [{ nodeName: 'calculator' }] },
        { mcpServers: [{}] },
        { playbooks: [{}] }
    ])
        assert.equal(openUploadShell(c, { ...role, ...options }), null)
    const reader = openUploadShell(c, role)
    const invalid = [
        { command: 'wc -c uploads/previous.csv' },
        { command: 'wc -l ' + file, workdir: '/elsewhere' },
        { command: 'wc -l ' + file, background: true },
        { command: 'head -n 0 ' + file },
        { command: 'head -11 ' + file },
        { command: 'ls uploads' },
        { command: 'wc -lc ' + file + ' ' + file },
        { command: 'cat ' + file },
        { command: 'head -1 ' + file + ' | wc -l' },
        { command: 'wc -lc ' + file + '\n' }
    ]
    for (const args of invalid) assert.throws(() => reader.validate(args), { code: 'native_unsupported' })
})
test('bounded windows leave private middle rows, limit output, and recheck cancellation and publication', () => {
    const a = openUploadShell(context('one\ntwo\nthree\n'), role)
    assert.equal(JSON.parse(a.execute({ command: 'head -1 ' + file })).output, 'one')
    assert.equal(JSON.parse(a.execute({ command: 'tail -1 ' + file })).output, 'three')
    assert.throws(() => a.execute({ command: 'head -2 ' + file }), { code: 'native_unsupported' })
    const b = openUploadShell(context('x'.repeat(4097) + '\nmiddle\nend\n'), role)
    assert.throws(() => b.execute({ command: 'head -1 ' + file }), { code: 'native_unsupported' })
    const c = openUploadShell(context(Buffer.from([27, 10, 1, 10, 0, 10])), role)
    assert.throws(() => c.execute({ command: 'tail -1 ' + file }), { code: 'native_unsupported' })
    const aborted = AbortSignal.abort()
    const cancelled = openUploadShell({ ...context(), workSignal: aborted }, role)
    assert.throws(() => cancelled.execute({ command: 'wc -l ' + file }), { name: 'AbortError' })
    let reads = 0
    const revoked = openUploadShell(
        {
            ...context(),
            assertNativeAuthority() {
                if (++reads === 2) throw Object.assign(Error('changed'), { code: 'harness_changed' })
            }
        },
        role
    )
    assert.throws(() => revoked.execute({ command: 'head -1 ' + file }), { code: 'harness_changed' })
})
