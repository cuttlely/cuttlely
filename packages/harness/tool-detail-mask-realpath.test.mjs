import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

// The data folder is reached through a link, so the workspace root and its real path differ.
const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-detail-real-'))
const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-detail-link-')), 'data')
fs.symlinkSync(real, link)
process.env.CUTTLELY_DATA_DIR = link
const { maskDetail } = await import('./run.mjs')
after(() => {
    fs.rmSync(path.dirname(link), { recursive: true, force: true })
    fs.rmSync(real, { recursive: true, force: true })
})

test('the real path of the workspace is replaced, also when joined after a URL', () => {
    const file = path.join(real, 'workspaces', 'analyst', 'private.csv')
    assert.equal(maskDetail(`read ${file}`).includes(real), false)
    for (const text of [`https://example.com/a,${file}`, `https://example.com/a;${file}`]) {
        assert.equal(maskDetail(text), 'a server path', text)
    }
})
