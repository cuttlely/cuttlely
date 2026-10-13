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
            currentTime: 0,
            readyState: 0,
            networkState: 0,
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
                // Same effect as HTMLMediaElement.load(): playback stops and the playhead returns to 0.
                video.currentTime = 0
                video.readyState = 0
                video.networkState = 2
                video.loaded = true
                video.beginFetch()
            },
            beginFetch() {
                if (open.has(video)) return
                open.add(video)
                calls.push(`fetch ${i}`)
                peak = Math.max(peak, open.size)
            },
            addEventListener(type, fn, capture) {
                this.events[capture === true || capture?.capture ? `${type}:capture` : type] = fn
            },
            removeEventListener(type, fn, capture) {
                const key = capture === true || capture?.capture ? `${type}:capture` : type
                if (this.events[key] === fn) delete this.events[key]
            },
            events: {}
        }
        return video
    })
    const listeners = { doc: {}, win: {} }
    const listen = (bucket) => (type, fn) => {
        ;(listeners[bucket][type] ||= []).push(fn)
    }
    const win = {
        matchMedia: (query) => ({ matches: (reduced && query.includes('reduce')) || (small && query.includes('max-width')) }),
        navigator: { connection: { saveData } },
        addEventListener: listen('win'),
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
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        querySelectorAll: (selector) => (selector.includes('[data-demo-video]') ? list : []),
        addEventListener: listen('doc')
    }
    const dispatch = (bucket, type, event = {}) => {
        for (const fn of listeners[bucket][type] || []) fn(event)
    }
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
        peak: () => peak,
        dispatch
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

test('a playing loop is not reset when its queue slot opens', () => {
    const { doc, win, calls, list, approach, finish } = fakes({ videos: 3 })
    initDemoVideo(doc, win)
    approach([0, 1, 2])
    const times = []
    let time = 0.49
    Object.defineProperty(list[2], 'currentTime', {
        configurable: true,
        get: () => time,
        set: (value) => {
            times.push(value)
            time = value
        }
    })
    // Already playing behind the two downloads that took the slots. readyState HAVE_ENOUGH_DATA.
    list[2].readyState = 4
    list[2].networkState = 1
    list[2].loaded = true
    finish(0)
    assert.deepEqual(times, [])
    assert.equal(list[2].currentTime, 0.49)
    assert.equal(list[2].readyState, 4)
    assert.equal(calls.includes('load 2'), false)
})

test('a fetch already in progress is not restarted by the queue', () => {
    const { doc, win, calls, list, approach } = fakes({ videos: 1 })
    list[0].readyState = 2
    list[0].networkState = 2
    list[0].currentTime = 0.2
    initDemoVideo(doc, win)
    approach([0])
    assert.equal(calls.includes('load 0'), false)
    assert.equal(list[0].currentTime, 0.2)
    assert.equal(typeof list[0].events.canplaythrough, 'function')
})

test('resume restarts a frozen download without resetting a playing loop', () => {
    const { doc, win, calls, list, approach, finish, dispatch, inFlight, peak } = fakes({ videos: 4 })
    initDemoVideo(doc, win)
    approach([0, 1, 2, 3])
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
    // Freeze closed the sockets and left both downloads LOADING. stalled must not free a slot.
    assert.equal(list[0].events.stalled, undefined)
    assert.equal(list[1].events.stalled, undefined)
    assert.equal(inFlight(), 2)
    const times = []
    let time = 0.49
    Object.defineProperty(list[0], 'currentTime', {
        configurable: true,
        get: () => time,
        set: (value) => {
            times.push(value)
            time = value
        }
    })
    // Loop 0 is playing with an aborted socket. Loop 1 never got a frame.
    list[0].readyState = 3
    list[0].networkState = 2
    list[0].paused = false
    list[1].currentTime = 0
    list[1].readyState = 1
    list[1].networkState = 2
    doc.hidden = true
    doc.visibilityState = 'hidden'
    dispatch('doc', 'resume')
    dispatch('win', 'pageshow', { persisted: false })
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
    doc.hidden = false
    doc.visibilityState = 'visible'
    dispatch('doc', 'visibilitychange')
    // Only the frozen, not-yet-playing download is selected again.
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 1']
    )
    assert.deepEqual(times, [])
    assert.equal(list[0].currentTime, 0.49)
    finish(0)
    finish(1)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 1', 'load 2', 'load 3']
    )
    assert.equal(inFlight(), 2)
    assert.equal(peak(), 2)
})

test('a back-forward restore restarts a frozen download once the page is visible', () => {
    const { doc, win, calls, approach, dispatch } = fakes({ videos: 2 })
    initDemoVideo(doc, win)
    approach([0, 1])
    dispatch('win', 'pageshow', { persisted: true })
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 0', 'load 1']
    )
})

test('a source error frees the slot only when no candidate is left', () => {
    const { doc, win, calls, list, approach } = fakes({ videos: 3 })
    initDemoVideo(doc, win)
    approach([0, 1, 2])
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
    // The WebM candidate failed and the MP4 candidate is still being tried.
    list[0].networkState = 2
    list[0].events['error:capture']()
    assert.equal(calls.includes('load 2'), false)
    list[0].networkState = 3
    list[0].events['error:capture']()
    assert.ok(calls.includes('load 2'))
})

test('a loop that has already run out of sources does not keep a slot', () => {
    const { doc, win, calls, list, approach } = fakes({ videos: 2 })
    list[0].networkState = 3
    initDemoVideo(doc, win)
    approach([0, 1])
    assert.equal(calls.includes('load 0'), false)
    assert.ok(calls.includes('load 1'))
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
