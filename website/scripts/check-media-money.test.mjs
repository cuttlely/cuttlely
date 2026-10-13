import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scanMedia } from './check-media-money.mjs'

test('homepage media shows no currency amount', async () => {
    const result = await scanMedia()
    if (result.skipped) {
        console.log(result.skipped)
        return
    }
    assert.deepEqual(result.hits, [], result.hits.map((hit) => `${hit.file} @ ${hit.at}: ${hit.text}`).join('\n'))
})
