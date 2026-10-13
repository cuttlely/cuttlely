import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canAutoplay, initDemoVideo, initVideoDialogs } from '../src/scripts/demo-video.mjs'

function fakes({ reduced = false, small = false, saveData = false, videos = 1, hasObserver = true } = {}) {
    const calls = []
    const observers = []
    const open = new Set()
    let peak = 0
    const list = Array.from({ length: videos }, (_, i) => {
        const video = {
            preload: 'none',
            loaded: false,
            dataset: {},
            // play() on a preload="none" element that has not been load()ed fetches on its own.
            play() {
                calls.push(`play ${i}`)
                if (!video.loaded) video.beginFetch()
                return Promise.resolve()
            },
            pause: () => calls.push(`pause ${i}`),
            load() {
                calls.push(`load ${i}`)
                video.loaded = true
                video.beginFetch()
            },
            beginFetch() {
                if (open.has(video)) return
                open.add(video)
                calls.push(`fetch ${i}`)
                peak = Math.max(peak, open.size)
            },
            addEventListener(type, fn) {
                this.events[type] = fn
            },
            removeEventListener(type, fn) {
                if (this.events[type] === fn) delete this.events[type]
            },
            events: {}
        }
        return video
    })
    const win = {
        matchMedia: (query) => ({ matches: (reduced && query.includes('reduce')) || (small && query.includes('max-width')) }),
        navigator: { connection: { saveData } },
        ...(hasObserver
            ? {
                  IntersectionObserver: class {
                      constructor(cb, options) {
                          this.cb = cb
                          this.options = options || {}
                          observers.push(this)
                      }
                      observe() {}
                  }
              }
            : {})
    }
    const doc = { querySelectorAll: (selector) => (selector.includes('[data-demo-video]') ? list : []) }
    const playObserver = () => observers.find((observer) => observer.options.threshold === 0.5)
    const nearObserver = () => observers.find((observer) => String(observer.options.rootMargin || '').includes('100%'))
    return {
        doc,
        win,
        calls,
        list,
        observers,
        show: (i, visible) => playObserver().cb([{ target: list[i], isIntersecting: visible }]),
        showAll: (indexes, visible = true) => playObserver().cb(indexes.map((i) => ({ target: list[i], isIntersecting: visible }))),
        approach: (indexes) => nearObserver().cb(indexes.map((i) => ({ target: list[i], isIntersecting: true }))),
        finish: (i) => {
            open.delete(list[i])
            list[i].events.canplaythrough()
        },
        fail: (i) => {
            open.delete(list[i])
            list[i].events.error()
        },
        inFlight: () => open.size,
        peak: () => peak
    }
}

/** A download may start only from load(), and play() may run only after that. */
function assertLoadsOwnTheFetches(calls) {
    const loaded = new Set()
    for (const call of calls) {
        const [kind, n] = call.split(' ')
        if (kind === 'load') loaded.add(n)
        if (kind === 'fetch') assert.ok(loaded.has(n), `fetch ${n} started without load()`)
        if (kind === 'play') assert.ok(loaded.has(n), `play ${n} ran before load()`)
    }
}

test('plays each video while it is on screen and pauses it when it scrolls away', () => {
    const { doc, win, calls, show } = fakes({ videos: 2 })
    assert.equal(initDemoVideo(doc, win), true)
    show(1, true)
    show(0, true)
    show(1, false)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('play') || call.startsWith('pause')),
        ['play 1', 'play 0', 'pause 1']
    )
    assertLoadsOwnTheFetches(calls)
})

test('starts loading about a viewport away, two at a time, in page order', () => {
    const { doc, win, calls, list, observers, approach, finish } = fakes({ videos: 4 })
    assert.equal(initDemoVideo(doc, win), true)
    assert.equal(observers.length, 2)
    assert.equal(observers.some((observer) => observer.options.threshold === 0.5), true)
    assert.equal(observers.some((observer) => observer.options.rootMargin === '100% 0px'), true)
    // Reported out of page order on purpose. The first two downloads follow the page.
    approach([3, 1, 0, 2])
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
    assert.equal(list[0].preload, 'auto')
    assert.equal(list[1].preload, 'auto')
    assert.equal(list[2].preload, 'none')
    assert.equal(list[3].preload, 'none')
    finish(1)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 2']
    )
    finish(0)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 2', 'load 3']
    )
    assert.equal(list[3].preload, 'auto')
    approach([0, 1, 2, 3])
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 2', 'load 3']
    )
})

test('scrolling the grid never has more than two loop downloads in flight', () => {
    const { doc, win, calls, showAll, inFlight, peak } = fakes({ videos: 7 })
    assert.equal(initDemoVideo(doc, win), true)
    // Responses are held: nothing fires canplaythrough. Every tile is half on screen at once.
    showAll([6, 4, 5, 3, 2, 1, 0])
    assert.equal(inFlight(), 2)
    assert.equal(peak(), 2)
    assertLoadsOwnTheFetches(calls)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
})

test('a half-visible loop jumps the queue and plays when its load starts', () => {
    const { doc, win, calls, approach, showAll, finish, inFlight, peak } = fakes({ videos: 7 })
    initDemoVideo(doc, win)
    approach([0, 1, 2, 3, 4, 5, 6])
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
    // 4, 5 and 6 are on screen before their turn. They move ahead of 2 and 3, still two in flight.
    showAll([6, 4, 5])
    assert.equal(inFlight(), 2)
    assert.equal(peak(), 2)
    finish(0)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 4']
    )
    assert.ok(calls.includes('play 4'))
    assert.equal(inFlight(), 2)
    assert.equal(peak(), 2)
    assertLoadsOwnTheFetches(calls)
})

test('a failed download frees its slot for the next loop', () => {
    const { doc, win, calls, approach, fail } = fakes({ videos: 3 })
    initDemoVideo(doc, win)
    approach([0, 1, 2])
    fail(0)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 2']
    )
})

test('leaves the videos alone for reduced motion, small screens, Save-Data, no videos or no IntersectionObserver', () => {
    for (const options of [{ reduced: true }, { small: true }, { saveData: true }, { videos: 0 }, { hasObserver: false }]) {
        const { doc, win, calls, list } = fakes(options)
        assert.equal(initDemoVideo(doc, win), false, JSON.stringify(options))
        assert.deepEqual(calls, [])
        assert.equal(
            list.every((video) => video.preload === 'none'),
            true
        )
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

test('canAutoplay uses navigator.connection.saveData', () => {
    const win = { matchMedia: () => ({ matches: false }) }
    assert.equal(canAutoplay({ ...win, navigator: { connection: { saveData: false } } }), true)
    assert.equal(canAutoplay({ ...win, navigator: { connection: { saveData: true } } }), false)
})

test('a Watch with sound link opens its dialog and plays; closing pauses', () => {
    const calls = []
    const handlers = {}
    const video = {
        preload: 'none',
        play: () => (calls.push('play'), Promise.resolve()),
        pause: () => calls.push('pause'),
        load: () => calls.push('load')
    }
    const dialog = {
        querySelector: () => video,
        showModal: () => calls.push('open'),
        close: () => (calls.push('close'), handlers.close()),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const linkHandlers = {}
    const link = {
        dataset: { videoDialogOpen: 'v1' },
        addEventListener: (type, fn) => {
            linkHandlers[type] = fn
        }
    }
    const doc = { querySelectorAll: () => [link], getElementById: (id) => (id === 'v1' ? dialog : null) }
    assert.equal(initVideoDialogs(doc), 1)
    let prevented = false
    linkHandlers.click({ preventDefault: () => (prevented = true) })
    assert.equal(prevented, true)
    handlers.click({ target: {} })
    handlers.click({ target: dialog })
    assert.deepEqual(calls, ['open', 'play', 'close', 'pause'])
})

test('the dialog video prefetches on pointerenter, focus or pointerdown and does not play', () => {
    const calls = []
    const video = {
        preload: 'none',
        play: () => (calls.push('play'), Promise.resolve()),
        pause: () => calls.push('pause'),
        load: () => calls.push('load')
    }
    const dialog = {
        querySelector: () => video,
        showModal: () => calls.push('open'),
        close: () => {},
        addEventListener: () => {}
    }
    const linkHandlers = {}
    const link = {
        dataset: { videoDialogOpen: 'v1' },
        addEventListener: (type, fn) => {
            linkHandlers[type] = fn
        }
    }
    const doc = { querySelectorAll: () => [link], getElementById: () => dialog }
    assert.equal(initVideoDialogs(doc), 1)
    for (const type of ['pointerenter', 'focus', 'pointerdown']) linkHandlers[type]()
    assert.equal(video.preload, 'auto')
    assert.deepEqual(calls, ['load'])
})
