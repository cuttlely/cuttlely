import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canAutoplay, initDemoVideo, initVideoDialogs } from '../src/scripts/demo-video.mjs'

function fakes({ reduced = false, small = false, saveData = false, videos = 1, hasObserver = true } = {}) {
    const calls = []
    const list = Array.from({ length: videos }, (_, i) => ({
        play: () => (calls.push(`play ${i}`), Promise.resolve()),
        pause: () => calls.push(`pause ${i}`)
    }))
    let callback = null
    const win = {
        matchMedia: (query) => ({ matches: (reduced && query.includes('reduce')) || (small && query.includes('max-width')) }),
        navigator: { connection: { saveData } },
        ...(hasObserver
            ? {
                  IntersectionObserver: class {
                      constructor(cb) {
                          callback = cb
                      }
                      observe(target) {
                          calls.push(`observe ${list.indexOf(target)}`)
                      }
                  }
              }
            : {})
    }
    const doc = { querySelectorAll: (selector) => (selector.includes('[data-demo-video]') ? list : []) }
    return { doc, win, calls, list, show: (i, visible) => callback([{ target: list[i], isIntersecting: visible }]) }
}

test('plays each video while it is on screen and pauses it when it scrolls away', () => {
    const { doc, win, calls, show } = fakes({ videos: 2 })
    assert.equal(initDemoVideo(doc, win), true)
    show(1, true)
    show(0, true)
    show(1, false)
    assert.deepEqual(calls, ['observe 0', 'observe 1', 'play 1', 'play 0', 'pause 1'])
})

test('leaves the videos alone for reduced motion, small screens, Save-Data, no videos or no IntersectionObserver', () => {
    for (const options of [{ reduced: true }, { small: true }, { saveData: true }, { videos: 0 }, { hasObserver: false }]) {
        const { doc, win, calls } = fakes(options)
        assert.equal(initDemoVideo(doc, win), false, JSON.stringify(options))
        assert.deepEqual(calls, [])
    }
})

test('without autoplay the narrated demo is unmuted for the tap that plays it', () => {
    const { doc, win, list } = fakes({ small: true, videos: 2 })
    list[0].dataset = { demoVideo: '' }
    list[0].muted = true
    list[1].dataset = { loopVideo: '' }
    list[1].muted = true
    assert.equal(initDemoVideo(doc, win), false)
    assert.deepEqual([list[0].muted, list[1].muted], [false, true])
})

test('canAutoplay works without the Network Information API', () => {
    assert.equal(canAutoplay({ matchMedia: () => ({ matches: false }), navigator: {} }), true)
})

test('a Watch with sound link opens its dialog and plays; closing pauses', () => {
    const calls = []
    const handlers = {}
    const video = { play: () => (calls.push('play'), Promise.resolve()), pause: () => calls.push('pause') }
    const dialog = {
        querySelector: () => video,
        showModal: () => calls.push('open'),
        close: () => (calls.push('close'), handlers.close()),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    let onClick = null
    const link = { dataset: { videoDialogOpen: 'v1' }, addEventListener: (type, fn) => (onClick = fn) }
    const doc = { querySelectorAll: () => [link], getElementById: (id) => (id === 'v1' ? dialog : null) }
    assert.equal(initVideoDialogs(doc), 1)
    let prevented = false
    onClick({ preventDefault: () => (prevented = true) })
    assert.equal(prevented, true)
    handlers.click({ target: {} })
    handlers.click({ target: dialog })
    assert.deepEqual(calls, ['open', 'play', 'close', 'pause'])
})
