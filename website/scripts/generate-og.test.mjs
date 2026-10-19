import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { renderOg } from './generate-og.mjs'

describe('generate-og', () => {
    it('writes a 1200x630 PNG under 300 KB', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-og-test-'))
        const out = path.join(dir, 'og-light.png')
        const result = await renderOg({ out })
        const buf = fs.readFileSync(out)
        assert.equal(result.width, 1200)
        assert.equal(result.height, 630)
        assert.equal(buf.readUInt32BE(16), 1200)
        assert.equal(buf.readUInt32BE(20), 630)
        assert.ok(buf.length < 300 * 1024, `${buf.length} bytes`)
        fs.rmSync(dir, { recursive: true, force: true })
    })
})
