import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LIMIT_BYTES, isMedia, mediaProblems, parseAllowlist } from './media-size.mjs'

describe('media size', () => {
    it('treats image and video extensions as media, in any case', () => {
        assert.equal(isMedia('website/public/media/products/testing.mp4'), true)
        assert.equal(isMedia('docs/shots/Run.PNG'), true)
        assert.equal(isMedia('a/b.webm'), true)
        assert.equal(isMedia('a/b.vtt'), false)
        assert.equal(isMedia('pnpm-lock.yaml'), false)
    })

    it('fails a new file over the limit and passes one at the limit', () => {
        const sizes = new Map([
            ['website/new.mp4', LIMIT_BYTES + 1],
            ['website/edge.png', LIMIT_BYTES],
            ['data/big.json', LIMIT_BYTES * 4],
            ['hermes/assets/big.gif', LIMIT_BYTES * 2]
        ])
        assert.deepEqual(mediaProblems(sizes, []), { oversized: [{ file: 'website/new.mp4', bytes: LIMIT_BYTES + 1 }], stale: [] })
    })

    it('passes an allowlisted file and reports a stale allowlist line', () => {
        const sizes = new Map([
            ['website/old.mp4', LIMIT_BYTES * 2],
            ['website/shrunk.webm', 1000]
        ])
        const result = mediaProblems(sizes, ['website/old.mp4', 'website/shrunk.webm', 'website/gone.mp4'])
        assert.deepEqual(result.oversized, [])
        assert.deepEqual(result.stale, ['website/shrunk.webm', 'website/gone.mp4'])
    })

    it('reads path lines and skips comments and blanks', () => {
        assert.deepEqual(parseAllowlist('# note\n\n./a/b.mp4\n  c\\d.png  \n'), ['a/b.mp4', 'c/d.png'])
    })
})
