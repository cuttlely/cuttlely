import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDemoVideo } from '../src/scripts/demo-video.mjs'

function fakes({ reduced = false, hasVideo = true, hasObserver = true } = {}) {
    const calls = []
    const video = { play: () => (calls.push('play'), Promise.resolve()), pause: () => calls.push('pause') }
    let callback = null
    const win = {
        matchMedia: (query) => ({ matches: reduced && query.includes('reduce') }),
        ...(hasObserver
            ? {
                  IntersectionObserver: class {
                      constructor(cb) {
                          callback = cb
                      }
                      observe(target) {
                          calls.push(target === video ? 'observe' : 'observe-other')
                      }
                  }
              }
            : {})
    }
    const doc = { querySelector: (selector) => (hasVideo && selector === '[data-demo-video]' ? video : null) }
    return { doc, win, calls, show: (visible) => callback([{ isIntersecting: visible }]) }
}

test('plays the demo video while it is on screen and pauses it when it scrolls away', () => {
    const { doc, win, calls, show } = fakes()
    assert.equal(initDemoVideo(doc, win), true)
    show(true)
    show(false)
    assert.deepEqual(calls, ['observe', 'play', 'pause'])
})

test('leaves the video alone for reduced motion, without the video, or without IntersectionObserver', () => {
    for (const options of [{ reduced: true }, { hasVideo: false }, { hasObserver: false }]) {
        const { doc, win, calls } = fakes(options)
        assert.equal(initDemoVideo(doc, win), false)
        assert.deepEqual(calls, [])
    }
})
