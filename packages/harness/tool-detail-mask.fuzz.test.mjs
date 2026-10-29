import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { hideWorkspacePaths, scanWorkspaceText, workspaceMaskState } from './images.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-detail-mask-fuzz-'))
const real = path.join(dir, 'sentinel-real-root')
const alias = path.join(dir, 'sentinel-link-root')
fs.mkdirSync(real)
fs.symlinkSync(real, alias, 'dir')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const seed = 0x6d61736b
function random() {
    let value = seed
    return () => {
        value ^= value << 13
        value ^= value >>> 17
        value ^= value << 5
        return (value >>> 0) / 0x100000000
    }
}
const next = random()
const root = '/var/sentinel-workspace-root'
const filename = 'sentinel-private-file.csv'
const file = `${root}/${filename}`
const jsonBody = (text) => JSON.stringify(text).slice(1, -1)
const encodings = (text) => [
    ...new Set([
        text,
        jsonBody(text),
        jsonBody(jsonBody(text)),
        text.replaceAll('/', '\\/'),
        encodeURI(text),
        encodeURIComponent(text),
        text.replaceAll('/', '%2f'),
        `file://${text}`
    ])
]
const forms = [
    ['posix', file],
    ['file-uri', `file://${file}`],
    ['home', `~/secret/${filename}`],
    ['drive', `C:\\secret\\${filename}`],
    ['unc', `\\\\host\\share\\${filename}`],
    ['json-escaped', jsonBody(`C:\\secret\\${filename}`)],
    ['escaped-slashes', file.replaceAll('/', '\\/')],
    ['percent', encodeURIComponent(file)],
    ['percent-lower', file.replaceAll('/', '%2f')],
    ['spaces', `${root}/private folder/${filename}`, true],
    ['parentheses', `${root}/private(archive)/${filename}`, true]
]
const positions = [
    ['bare', (p) => p],
    ['bold', (p) => `**${p}**`],
    ['underscore', (p) => `_${p}_`],
    ['strike', (p) => `~~${p}~~`],
    ['code', (p) => '`' + p + '`'],
    ['backtick-fence', (p) => '```text\n' + p + '\n```'],
    ['tilde-fence', (p) => `~~~text\n${p}\n~~~`],
    ['link-label', (p) => `[${p}](https://example.com/x)`],
    ['link-destination', (p) => `[docs/x.md](${p})`],
    ['link-both', (p) => `[${p}](${p})`],
    ['link-title', (p) => `[docs/x.md](#anchor "${p}")`],
    ['autolink', (p) => `<${p}>`],
    ['html-href', (p) => `<a href="${p}">x</a>`],
    ['html-src', (p) => `<img src="${p}">`],
    ['single-quote', (p) => `'${p}'`],
    ['double-quote', (p) => `"${p}"`],
    ['backtick-quote', (p) => 'note:`' + p + '`'],
    ['colon', (p) => `path:${p}`],
    ['comma', (p) => `path,${p}`],
    ['semicolon', (p) => `path;${p}`],
    ['equals', (p) => `path=${p}`],
    ['json-key', (p) => JSON.stringify({ [p]: 'ready' })],
    ['json-value', (p) => JSON.stringify({ value: p })],
    ['json-nested', (p) => JSON.stringify({ data: [{ value: p }] })],
    ['json-in-string', (p) => JSON.stringify({ result: JSON.stringify({ value: p }) })],
    ['prose', (p) => `See ${p} for details.`]
]
const benign = [
    'https://example.com/a/b?q=3/4#anchor',
    'http://example.com/a_b',
    '[docs/x.md](#a)',
    'and/or',
    '3/4',
    'Q3..Q4',
    '...',
    'docs/report.md',
    '[./README.md](#overview)',
    '[docs/report.csv](https://example.com/report.csv)',
    '<a href="https://example.com/x">x</a>'
]

function stream(input, width, workspace) {
    const state = workspaceMaskState()
    let shown = ''
    let peak = 0
    for (let at = 0; at < input.length; ) {
        const size = width || 1 + Math.floor(next() * 97)
        shown += scanWorkspaceText(state, input.slice(at, at + size), workspace)
        peak = Math.max(peak, state.token?.length || 0, state.buffer?.length || 0)
        at += size
    }
    return { shown: shown + scanWorkspaceText(state, '', workspace, true), peak }
}

test('seeded path masking oracles across syntax, encodings and chunk splits', () => {
    const started = performance.now()
    const failures = new Map()
    const examples = []
    let total = 0
    let checks = 0
    const fail = (oracle, position, form, input, output) => {
        const key = `${oracle} x ${position} x ${form}`
        failures.set(key, (failures.get(key) || 0) + 1)
        if (examples.length < 8) examples.push({ class: key, input: input.slice(0, 180), output: output.slice(0, 180) })
    }
    const exercise = (input, position, form, workspace = root, residual = false, unchanged = false, roots = [workspace]) => {
        const whole = stream(input, input.length || 1, workspace).shown
        const buffered = hideWorkspacePaths(input, workspace)
        let validJson = false
        try {
            JSON.parse(input)
            validJson = true
        } catch {}
        const forbidden = [...roots.flatMap(encodings), ...(!residual && !unchanged ? encodings(filename) : [])]
        for (const width of [1, 2, 3, 7, 64, 1024, 0]) {
            total++
            const { shown, peak } = stream(input, width, workspace)
            const outputs = [shown, buffered]
            checks++
            if (outputs.some((out) => forbidden.some((secret) => out.toLowerCase().includes(secret.toLowerCase()))))
                fail('no-leak', position, form, input, shown)
            checks++
            if (validJson)
                for (const output of outputs) {
                    try {
                        JSON.parse(output)
                    } catch {
                        fail('json-valid', position, form, input, output)
                        break
                    }
                }
            checks++
            if (shown !== whole || buffered !== whole) fail('chunk-independent', position, form, input, shown)
            checks++
            if (unchanged && outputs.some((out) => out !== input)) fail('benign', position, form, input, shown)
            checks++
            if (peak > 8192 + Math.max(...roots.flatMap(encodings).map((s) => s.length))) fail('bounded-hold', position, form, input, shown)
        }
    }
    for (const [form, value, residual] of forms)
        for (const [position, wrap] of positions) exercise(wrap(value), position, form, root, residual)
    for (const text of benign) exercise(text, 'benign', 'prose', root, false, true)
    for (const workspace of [root, alias]) {
        const roots = workspace === alias ? [alias, real] : [root]
        for (const actual of roots)
            for (const encoded of encodings(actual)) {
                exercise(`prefix${encoded}/`, 'embedded-root', workspace === alias ? 'symlink' : 'literal', workspace, true, false, roots)
            }
        // Unbroken base64-like text and minified JSON: root spans the cap/overlap at width 1.
        for (const prefix of [8100, 8185]) {
            const token = 'A'.repeat(prefix) + roots.at(-1) + 'Z'.repeat(20000 - prefix)
            exercise(token, 'long-token', workspace === alias ? 'symlink' : 'literal', workspace, true, false, roots)
            exercise(
                JSON.stringify({ data: token }),
                'minified-json',
                workspace === alias ? 'symlink' : 'literal',
                workspace,
                true,
                false,
                roots
            )
        }
    }
    const count = [...failures.values()].reduce((a, b) => a + b, 0)
    console.log(
        'MASK_FUZZ_SUMMARY ' +
            JSON.stringify({
                seed,
                totalCases: total,
                checks,
                failures: count,
                classes: Object.fromEntries(failures),
                runtimeMs: Math.round(performance.now() - started),
                examples
            })
    )
    assert.equal(count, 0, `${count} oracle failures in ${failures.size} classes; see MASK_FUZZ_SUMMARY`)
})
