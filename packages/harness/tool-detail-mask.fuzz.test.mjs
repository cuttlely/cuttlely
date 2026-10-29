import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-detail-mask-fuzz-'))
process.env.CUTTLELY_DATA_DIR = dir
after(() => fs.rmSync(dir, { recursive: true, force: true }))
const { maskWorkspacePaths } = await import('./run.mjs')
const { hideWorkspacePaths } = await import('./images.mjs')
const { specialistWorkspace } = await import('./profile.mjs')

const root = path.dirname(specialistWorkspace('_'))
let seed = 0x6d61736b
const next = () => ((seed ^= seed << 13), (seed ^= seed >>> 17), (seed ^= seed << 5), (seed >>> 0) / 2 ** 32)
const pick = (list) => list[Math.floor(next() * list.length)]
const pools = {
    path: [`${root}/analyst/fuzz-private.csv`, `${root}/my reports/fuzz-private.csv`, '/tmp/fuzz-private.csv', '~/fuzz/private.txt'],
    url: ['https://example.com/a/b', 'http://[::1]:3000/api', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://example.com/q?x=1&y=2'],
    benign: ['and/or', '3/4', 'Q3..Q4', 'More...', '10/24/2026', 'docs/guide.md', 'period_start..period_end', '2026-07-01..2026-09-30'],
    plain: ['ready', 'Closed Lost', 'x'.repeat(1500), 'lorem ipsum '.repeat(150)]
}
const separators = ['|', ',', ' ', '"', '","']
// Two plain fragments take any separator. A slash, dot or URL fragment is joined by a space, and a quote
// only joins when no such fragment follows: main's masker reads those as one token (tracked separately).
function compose(kinds) {
    const parts = Array.from({ length: 2 + Math.floor(next() * 2) }, () => {
        const kind = pick(kinds)
        return [kind, pick(pools[kind])]
    })
    let text = parts[0][1]
    parts.slice(1).forEach(([kind, value], index) => {
        const plain = kind === 'plain' && parts[index][0] === 'plain'
        const restPlain = parts.slice(index + 1).every(([later]) => later === 'plain')
        const choices = restPlain ? separators : separators.filter((separator) => !separator.includes('"'))
        text += (plain ? pick(choices) : ' ') + value
    })
    return text
}
const rootOrStart = (text) => text.includes(root) || /(?:^|[\s"'|,(\[<>=])(?:[\/~\\]|file:)/.test(text)

test('composed rows keep valid JSON and unchanged siblings; text without a path is unchanged', () => {
    for (let round = 0; round < 150; round++) {
        const rows = Array.from({ length: 2 + Math.floor(next() * 3) }, () => ({
            file: compose(['path', 'url', 'benign', 'plain']).replace(/^/, pick(pools.path) + ' '),
            note: compose(['url', 'benign', 'plain']),
            blob: 'y'.repeat(8192 + Math.floor(next() * 4096)),
            count: Math.floor(next() * 1000)
        }))
        // The run.mjs shape: values are masked, then encoded twice.
        const detail = JSON.stringify({ result: JSON.stringify(maskWorkspacePaths({ rows })) })
        const parsed = JSON.parse(JSON.parse(detail).result).rows
        assert.equal(detail.includes(root), false)
        assert.equal(detail.includes('fuzz-private'), false)
        rows.forEach((row, index) => {
            for (const key of ['note', 'blob', 'count']) assert.equal(parsed[index][key], row[key], key)
        })
        const text = compose(['url', 'benign', 'plain'])
        if (!rootOrStart(text)) assert.equal(hideWorkspacePaths(text, root), text, text.slice(0, 120))
    }
})

test('masking stays linear at twice the check size', () => {
    const started = performance.now()
    hideWorkspacePaths(`"${root}/a${' '.repeat(64000)}b"`, root)
    hideWorkspacePaths(`"${root}/${'a b/'.repeat(32000)}"`, root)
    hideWorkspacePaths(`'${`${root}/x `.repeat(8000)}'`, root)
    assert.ok(performance.now() - started < 2000)
})
