import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
                if (!video.finishRestart) return
                // The restarted resource reaches metadata, then can play through. The test does not fire that.
                if (!video.seekable || !video.seekable.length) video.seekable = { length: 1, end: () => Number.POSITIVE_INFINITY }
                video.readyState = 1
                video.emit('loadedmetadata')
                video.readyState = 3
                video.emit('canplay')
                video.readyState = 4
                video.networkState = 1
                open.delete(video)
                video.emit('canplaythrough')
            },
            beginFetch() {
                if (open.has(video)) return
                open.add(video)
                calls.push(`fetch ${i}`)
                peak = Math.max(peak, open.size)
            },
            addEventListener(type, fn, capture) {
                const key = capture === true || capture?.capture ? `${type}:capture` : type
                const list = this.events[key] || (this.events[key] = [])
                list.push(fn)
            },
            removeEventListener(type, fn, capture) {
                const key = capture === true || capture?.capture ? `${type}:capture` : type
                const list = this.events[key]
                if (!list) return
                const index = list.indexOf(fn)
                if (index >= 0) list.splice(index, 1)
                if (list.length === 0) delete this.events[key]
            },
            emit(type) {
                const list = this.events[type]
                if (!list) return
                for (const fn of [...list]) fn()
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
            list[i].emit('canplaythrough')
        },
        fail: (i) => {
            open.delete(list[i])
            list[i].emit('error')
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
    assert.equal(
        observers.some((observer) => observer.options.threshold === 0.5),
        true
    )
    assert.equal(
        observers.some((observer) => observer.options.rootMargin === '100% 0px'),
        true
    )
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
    assert.equal(list[0].events.canplaythrough.length, 1)
})

function listenerCounts(video) {
    const count = (type) => video.events[type]?.length || 0
    return {
        loadedmetadata: count('loadedmetadata'),
        loadeddata: count('loadeddata'),
        canplay: count('canplay'),
        progress: count('progress'),
        seeking: count('seeking')
    }
}

const oneRestoreListener = {
    loadedmetadata: 1,
    loadeddata: 1,
    canplay: 1,
    progress: 1,
    seeking: 1
}

function holdTime(video, start) {
    let time = start
    let ignoreNextRestore = false
    Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get: () => time,
        set: (value) => {
            if (value === 0) {
                time = 0
                return
            }
            if (ignoreNextRestore) {
                ignoreNextRestore = false
                return
            }
            time = value
        }
    })
    video.seekable = { length: 0, end: () => 0 }
    return {
        arm: () => {
            ignoreNextRestore = true
        },
        setSeekable(end) {
            video.seekable = { length: end > 0 ? 1 : 0, end: () => end }
        },
        jump(value) {
            time = value
        }
    }
}

function trackTime(video, start) {
    const times = []
    let time = start
    Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get: () => time,
        set: (value) => {
            times.push(value)
            time = value
        }
    })
    return times
}

test('resume restarts a playing loop and a paused one, then the next loops start', async () => {
    const { doc, win, calls, list, approach, show, dispatch, inFlight, peak } = fakes({ videos: 4 })
    initDemoVideo(doc, win)
    approach([0, 1, 2, 3])
    show(0, true)
    show(1, false)
    const playing = trackTime(list[0], 0.49)
    const paused = trackTime(list[1], 0.2)
    list[0].readyState = 3
    list[0].networkState = 2
    list[0].paused = false
    list[1].readyState = 3
    list[1].networkState = 2
    list[1].paused = true
    list[0].finishRestart = true
    list[1].finishRestart = true
    assert.equal(list[0].events.stalled, undefined)
    dispatch('doc', 'resume')
    await Promise.resolve()
    assert.equal(list[0].currentTime, 0.49)
    assert.equal(list[1].currentTime, 0.2)
    assert.ok(playing.includes(0.49))
    assert.ok(paused.includes(0.2))
    assert.ok(calls.includes('play 0'))
    assert.equal(calls.filter((call) => call === 'play 1').length, 0)
    const loads = calls.filter((call) => call.startsWith('load'))
    assert.deepEqual(
        loads.filter((call) => call === 'load 0'),
        ['load 0', 'load 0']
    )
    assert.deepEqual(
        loads.filter((call) => call === 'load 1'),
        ['load 1', 'load 1']
    )
    assert.equal(loads.includes('load 2') && loads.includes('load 3'), true)
    assert.equal(list[2].preload, 'auto')
    assert.equal(list[3].preload, 'auto')
    assert.equal(inFlight(), 2)
    assert.equal(peak(), 2)
})

test('a seek ignored at loadedmetadata is applied once that time is seekable', async () => {
    const { doc, win, calls, list, approach, show, dispatch } = fakes({ videos: 2 })
    initDemoVideo(doc, win)
    approach([0, 1])
    show(0, true)
    show(1, false)
    const playing = holdTime(list[0], 0.576)
    const paused = holdTime(list[1], 0.361)
    list[0].readyState = 3
    list[0].networkState = 2
    list[1].readyState = 3
    list[1].networkState = 2
    const playsBefore = calls.filter((call) => call === 'play 0').length
    dispatch('doc', 'resume')
    await Promise.resolve()
    list[0].emit('loadedmetadata')
    list[1].emit('loadedmetadata')
    assert.equal(list[0].currentTime, 0)
    assert.equal(list[1].currentTime, 0)
    // Metadata arrived before the saved time was in the seekable range.
    list[0].emit('loadeddata')
    list[1].emit('loadeddata')
    assert.equal(list[0].currentTime, 0)
    assert.equal(list[1].currentTime, 0)
    playing.setSeekable(0.576)
    paused.setSeekable(0.361)
    list[0].emit('canplay')
    list[1].emit('canplay')
    assert.equal(list[0].currentTime, 0.576)
    assert.equal(list[1].currentTime, 0.361)
    assert.equal(calls.filter((call) => call === 'play 0').length, playsBefore + 1)
    assert.equal(calls.filter((call) => call === 'play 1').length, 0)
    assert.equal(list[0].events.canplay, undefined)
    assert.equal(list[1].events.loadeddata, undefined)
})

test('a second resume keeps the original playhead while the first restore is still open', async () => {
    const { doc, win, calls, list, approach, show, dispatch } = fakes({ videos: 2 })
    initDemoVideo(doc, win)
    approach([0, 1])
    show(0, true)
    show(1, false)
    // Seeks stick only once the range covers them. Playback can move on from 0 in between.
    const partialTime = (video, start) => {
        let time = start
        video.seekable = { length: 0, end: () => 0 }
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            get: () => time,
            set: (value) => {
                if (value === 0) {
                    time = 0
                    return
                }
                const range = video.seekable
                if (range && range.length > 0 && range.end(0) >= value) time = value
            }
        })
        return {
            advance(value) {
                time = value
            },
            setSeekable(end) {
                video.seekable = { length: end > 0 ? 1 : 0, end: () => end }
            }
        }
    }
    const playing = partialTime(list[0], 2.5)
    const paused = partialTime(list[1], 2.5)
    list[0].readyState = 3
    list[0].networkState = 2
    list[1].readyState = 3
    list[1].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    assert.deepEqual(listenerCounts(list[0]), oneRestoreListener)
    assert.deepEqual(listenerCounts(list[1]), oneRestoreListener)
    list[0].emit('loadedmetadata')
    list[1].emit('loadedmetadata')
    assert.equal(list[0].currentTime, 0)
    assert.equal(list[1].currentTime, 0)
    playing.advance(0.4)
    paused.advance(0.4)
    assert.equal(list[0].currentTime, 0.4)
    list[0].readyState = 2
    list[0].networkState = 2
    list[1].readyState = 2
    list[1].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    assert.deepEqual(listenerCounts(list[0]), oneRestoreListener)
    assert.deepEqual(listenerCounts(list[1]), oneRestoreListener)
    list[0].emit('loadedmetadata')
    list[1].emit('loadedmetadata')
    playing.setSeekable(12)
    paused.setSeekable(12)
    list[0].emit('canplay')
    list[1].emit('canplay')
    assert.equal(list[0].currentTime, 2.5)
    assert.equal(list[1].currentTime, 2.5)
    assert.deepEqual(listenerCounts(list[0]), {
        loadedmetadata: 0,
        loadeddata: 0,
        canplay: 0,
        progress: 0,
        seeking: 0
    })
    assert.equal(calls.filter((call) => call === 'play 1').length, 0)
    assert.ok(calls.includes('play 0'))
})

test('a visitor seek during a restore keeps their time', async () => {
    const orders = [
        ['canplay', 'seeking', 0],
        ['seeking', 'canplay', 0],
        ['seeking', 'canplay', 1.2],
        ['canplay', 'seeking', 1.2]
    ]
    for (const [first, second, visitorTime] of orders) {
        const { doc, win, list, approach, dispatch } = fakes({ videos: 1 })
        initDemoVideo(doc, win)
        approach([0])
        const held = holdTime(list[0], 2.5)
        list[0].readyState = 3
        list[0].networkState = 2
        list[0].seeking = false
        dispatch('doc', 'resume')
        await Promise.resolve()
        held.setSeekable(12)
        held.jump(visitorTime)
        if (first === 'seeking') {
            list[0].seeking = true
            list[0].emit('seeking')
            list[0].seeking = false
            list[0].emit('canplay')
        } else {
            // Chrome reports canplay while seeking is still true and currentTime is the scrub target.
            list[0].seeking = true
            list[0].emit('canplay')
            list[0].emit('seeking')
            list[0].seeking = false
        }
        assert.equal(list[0].currentTime, visitorTime, `${first} then ${second} at ${visitorTime}`)
    }
})

test('a later freeze after a zero restore reads the live playhead', async () => {
    const { doc, win, calls, list, approach, show, dispatch } = fakes({ videos: 2 })
    initDemoVideo(doc, win)
    approach([0, 1])
    const playTimes = []
    const original = list[0].play
    list[0].play = () => {
        playTimes.push(list[0].currentTime)
        return original.call(list[0])
    }
    show(0, true)
    show(1, false)
    list[0].currentTime = 0
    list[1].currentTime = 0
    list[0].readyState = 2
    list[1].readyState = 2
    list[0].networkState = 2
    list[1].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    // Before metadata the zero restore stays registered, so a second resume would still replace it.
    assert.equal(list[0].events.loadedmetadata.length, 1)
    list[0].emit('loadedmetadata')
    list[1].emit('loadedmetadata')
    const playsAfterMetadata = playTimes.length
    list[0].currentTime = 2.5
    list[1].currentTime = 2.5
    list[0].readyState = 2
    list[1].readyState = 2
    list[0].networkState = 2
    list[1].networkState = 2
    list[0].seekable = { length: 1, end: () => 12 }
    list[1].seekable = { length: 1, end: () => 12 }
    dispatch('doc', 'resume')
    await Promise.resolve()
    list[0].emit('loadedmetadata')
    list[1].emit('loadedmetadata')
    assert.equal(list[0].currentTime, 2.5)
    assert.equal(list[1].currentTime, 2.5)
    assert.deepEqual(
        playTimes.slice(playsAfterMetadata).filter((time) => time === 0),
        []
    )
    assert.equal(calls.filter((call) => call === 'play 1').length, 0)
})

test('two resumes at the start leave one loadedmetadata listener', async () => {
    const { doc, win, calls, list, approach, show, dispatch } = fakes({ videos: 1 })
    initDemoVideo(doc, win)
    approach([0])
    show(0, true)
    list[0].currentTime = 0
    list[0].readyState = 2
    list[0].networkState = 2
    const playsBefore = calls.filter((call) => call === 'play 0').length
    dispatch('doc', 'resume')
    await Promise.resolve()
    assert.equal(list[0].events.loadedmetadata.length, 1)
    list[0].readyState = 2
    list[0].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    assert.equal(list[0].events.loadedmetadata.length, 1)
    list[0].emit('loadedmetadata')
    assert.equal(calls.filter((call) => call === 'play 0').length, playsBefore + 1)
})

test('a fully buffered held loop is not loaded again on resume', async () => {
    const { doc, win, calls, list, approach, dispatch } = fakes({ videos: 1 })
    initDemoVideo(doc, win)
    approach([0])
    const times = trackTime(list[0], 0.5)
    list[0].readyState = 4
    list[0].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0']
    )
    assert.equal(list[0].currentTime, 0.5)
    assert.deepEqual(times, [])
})

test('a playhead the visitor moved after the reload is not seeked back', async () => {
    const { doc, win, list, approach, dispatch } = fakes({ videos: 1 })
    initDemoVideo(doc, win)
    approach([0])
    const held = holdTime(list[0], 0.576)
    list[0].readyState = 3
    list[0].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    list[0].emit('loadedmetadata')
    assert.equal(list[0].currentTime, 0)
    held.jump(1.2)
    list[0].emit('seeking')
    held.setSeekable(2)
    list[0].emit('canplay')
    assert.equal(list[0].currentTime, 1.2)
    assert.equal(list[0].events.canplay, undefined)
    // The seek settled the restore, so the next resume reads the visitor's time.
    list[0].readyState = 2
    list[0].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    list[0].emit('loadedmetadata')
    assert.equal(list[0].currentTime, 1.2)
})

test('resume and a back-forward pageshow in one turn restart each held loop once', async () => {
    const { doc, win, calls, list, approach, dispatch } = fakes({ videos: 2 })
    initDemoVideo(doc, win)
    approach([0, 1])
    list[0].readyState = 2
    list[0].networkState = 2
    list[1].readyState = 2
    list[1].networkState = 2
    dispatch('doc', 'resume')
    dispatch('win', 'pageshow', { persisted: true })
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
    await Promise.resolve()
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 0', 'load 1']
    )
})

test('a later freeze restarts a held loop again', async () => {
    const { doc, win, calls, list, approach, dispatch } = fakes({ videos: 2 })
    initDemoVideo(doc, win)
    approach([0, 1])
    list[0].networkState = 2
    list[1].networkState = 2
    dispatch('doc', 'resume')
    await Promise.resolve()
    list[0].networkState = 2
    list[0].readyState = 1
    list[1].networkState = 2
    list[1].readyState = 1
    dispatch('doc', 'resume')
    await Promise.resolve()
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1', 'load 0', 'load 1', 'load 0', 'load 1']
    )
})

test('a resume while the page is hidden waits until it is visible', async () => {
    const { doc, win, calls, list, approach, dispatch } = fakes({ videos: 2 })
    initDemoVideo(doc, win)
    approach([0, 1])
    list[0].networkState = 2
    list[0].readyState = 2
    list[1].networkState = 2
    list[1].readyState = 2
    doc.hidden = true
    doc.visibilityState = 'hidden'
    dispatch('doc', 'resume')
    dispatch('win', 'pageshow', { persisted: false })
    await Promise.resolve()
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load')),
        ['load 0', 'load 1']
    )
    doc.hidden = false
    doc.visibilityState = 'visible'
    dispatch('doc', 'visibilitychange')
    await Promise.resolve()
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
    list[0].emit('error:capture')
    assert.equal(calls.includes('load 2'), false)
    list[0].networkState = 3
    list[0].emit('error:capture')
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

function control(dataset) {
    const listeners = {}
    return {
        dataset,
        hidden: false,
        addEventListener(type, fn) {
            ;(listeners[type] ||= []).push(fn)
        },
        click() {
            for (const fn of listeners.click || []) fn({ preventDefault() {}, target: this })
        }
    }
}

function shellVideo(dataset) {
    const listeners = {}
    const video = {
        dataset,
        muted: true,
        defaultMuted: true,
        loop: true,
        controls: true,
        volume: 0,
        currentTime: 0,
        paused: true,
        preload: 'none',
        readyState: 0,
        networkState: 0,
        poster: '/poster.webp',
        addEventListener(type, fn) {
            ;(listeners[type] ||= []).push(fn)
        },
        removeEventListener() {},
        play() {
            video.paused = false
            video.calls.push('play')
            return Promise.resolve()
        },
        pause() {
            video.paused = true
            video.calls.push('pause')
        },
        load() {
            video.calls.push('load')
        },
        click() {
            for (const fn of listeners.click || []) fn({ preventDefault() {}, target: video })
        },
        emit(type) {
            for (const fn of [...(listeners[type] || [])]) fn()
        },
        calls: []
    }
    return video
}

test('the home page puts a play button on the hero and on every tile loop', () => {
    const src = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8')
    assert.equal((src.match(/slug: '/g) || []).length, 6)
    assert.match(src, /slug: 'chatflows'/)
    assert.equal(src.includes("slug: 'testing'"), false)
    assert.match(src, /<button type="button" class="cl-play-overlay" data-play-with-sound aria-label="Play the demo with sound">/)
    assert.match(src, /aria-label="Play the testing video with sound"/)
    const ids = [
        'watch-a-team-resolve-a-complaint',
        'one-complaint-three-specialists',
        'agent-teams-that-power-your-apps',
        'test-every-change-before-it-goes-live',
        'use-a-team-from-your-app',
        'small-context-big-answers',
        'tools-your-teams-use',
        'start-in-minutes',
        'bring-your-existing-flows'
    ]
    let at = -1
    for (const id of ids) {
        const next = src.indexOf(`id="${id}"`)
        assert.ok(next > at, id)
        at = next
    }
    assert.equal((src.match(/Test with up to 100 question-and-answer pairs, with more on the roadmap\./g) || []).length, 1)
    const tiles = src.slice(src.indexOf('class="cl-tile-media"'), src.indexOf('class="cl-tile-link"'))
    assert.match(tiles, /data-loop-video/)
    assert.match(tiles, /<button/)
    assert.match(tiles, /type="button"/)
    assert.match(tiles, /data-play-with-sound/)
    assert.match(tiles, /data-video-dialog-open=\{`video-\$\{tool\.video\.slug\}`\}/)
    assert.match(tiles, /aria-label=\{`Play \$\{tool\.title\} with sound`\}/)
})

test('the home page keeps the old anchors, one testing video, and no testing tile', () => {
    const src = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8')
    for (const id of ['chat-with-a-team-in-minutes', 'ship-changes-safely-draft-compare-publish-roll-back', 'run-it-your-way']) {
        assert.match(src, new RegExp(`id="${id}"`))
    }
    const tools = src.slice(src.indexOf('const tools'), src.indexOf('const installs'))
    assert.equal(tools.includes("slug: 'testing'"), false)
    assert.equal(tools.includes('Test before you publish'), false)
    assert.match(tools, /slug: 'chatflows'/)
    assert.equal((src.match(/\/media\/products\/testing\.mp4/g) || []).length, 1)
    assert.equal((src.match(/aria-label="Play the testing video with sound"/g) || []).length, 1)
})

test('reduced motion, a narrow screen and Save-Data keep the poster and the play button', () => {
    for (const options of [{ reduced: true }, { small: true }, { saveData: true }]) {
        const video = shellVideo({ demoVideo: '' })
        const button = control({ playWithSound: '' })
        video.nextElementSibling = button
        const doc = { querySelectorAll: () => [video], addEventListener() {} }
        const win = {
            matchMedia: (query) => ({
                matches: (options.reduced && query.includes('reduce')) || (options.small && query.includes('max-width'))
            }),
            navigator: { connection: { saveData: !!options.saveData } },
            addEventListener() {}
        }
        assert.equal(initDemoVideo(doc, win), false, JSON.stringify(options))
        assert.equal(button.hidden, false)
        assert.equal(video.poster, '/poster.webp')
        assert.equal(video.preload, 'none')
        assert.equal(video.paused, true)
        assert.deepEqual(video.calls, [])
    }
})

test('the hero play button and the preview start at 0 with sound and do not loop', () => {
    const video = shellVideo({ demoVideo: '' })
    const button = control({ playWithSound: '' })
    video.nextElementSibling = button
    video.currentTime = 4.2
    const doc = { querySelectorAll: () => [video], addEventListener() {} }
    const win = {
        matchMedia: () => ({ matches: true }),
        navigator: { connection: { saveData: false } },
        addEventListener() {}
    }
    assert.equal(initDemoVideo(doc, win), false)
    video.volume = 0.4
    button.click()
    assert.equal(video.currentTime, 0)
    assert.equal(video.muted, false)
    assert.equal(video.loop, false)
    assert.equal(video.controls, true)
    assert.equal(video.volume, 0.4)
    assert.equal(button.hidden, true)
    assert.equal(video.calls.includes('load'), false)
    assert.equal(video.paused, false)
    video.currentTime = 9
    video.calls.length = 0
    video.click()
    assert.equal(video.currentTime, 9, 'a click during sound playback leaves the playhead')
    video.emit('ended')
    assert.equal(button.hidden, false)
    assert.equal(video.currentTime, 0)
    assert.equal(video.muted, true)
    assert.equal(video.loop, true)
    assert.equal(video.controls, false)
    assert.equal(video.paused, true)
    assert.equal(video.calls.includes('play'), false)
})

test('without autoplay, ending the hero loads the poster only after its sources are detached', () => {
    const source = {
        removed: false,
        remove() {
            this.removed = true
        }
    }
    const attached = [source]
    const video = shellVideo({ demoVideo: '' })
    const button = control({ playWithSound: '' })
    video.nextElementSibling = button
    video.querySelectorAll = () => attached.filter((item) => !item.removed)
    video.appendChild = (node) => {
        node.removed = false
    }
    const loads = []
    video.load = () => {
        loads.push(video.querySelectorAll('source').length)
    }
    const doc = { querySelectorAll: () => [video], addEventListener() {} }
    const win = {
        matchMedia: () => ({ matches: true }),
        navigator: { connection: { saveData: false } },
        addEventListener() {}
    }
    initDemoVideo(doc, win)
    button.click()
    assert.equal(loads.length, 0)
    video.emit('ended')
    assert.deepEqual(loads, [0])
    assert.equal(source.removed, true)
    assert.equal(button.hidden, false)
    button.click()
    assert.equal(source.removed, false)
    assert.deepEqual(loads, [0])
    assert.equal(video.muted, false)
    assert.equal(video.paused, false)
})

test('a sounding hero returns to the silent preview when a tile dialog pauses it', () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    hero.volume = 0.4
    const calls = []
    const handlers = {}
    const full = {
        currentTime: 1,
        muted: true,
        loop: false,
        volume: 0.35,
        controls: true,
        paused: true,
        dataset: {},
        play: () => (calls.push('dialog-play'), (full.paused = false), Promise.resolve()),
        pause: () => (calls.push('dialog-pause'), (full.paused = true))
    }
    const dialog = {
        querySelector: () => full,
        showModal: () => calls.push('open'),
        close: () => (calls.push('close'), handlers.close()),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const tileButton = control({ playWithSound: '', videoDialogOpen: 'v1' })
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: (id) => (id === 'v1' ? dialog : null),
        querySelectorAll: (selector) => {
            if (selector === 'video') return [hero, full]
            if (String(selector).includes('data-video-dialog-open')) return [tileButton]
            if (String(selector).includes('data-demo-video')) return [hero]
            return []
        }
    }
    hero.ownerDocument = doc
    full.ownerDocument = doc
    assert.equal(initDemoVideo(doc, win), true)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb([{ target: hero, isIntersecting: true }])
    heroButton.click()
    assert.equal(hero.muted, false)
    assert.equal(hero.loop, false)
    assert.equal(hero.controls, true)
    assert.equal(heroButton.hidden, true)
    assert.equal(hero.volume, 0.4)
    hero.currentTime = 2.2
    assert.equal(initVideoDialogs(doc), 1)
    tileButton.click()
    assert.equal(hero.paused, true)
    assert.equal(hero.muted, true)
    assert.equal(hero.loop, true)
    assert.equal(hero.controls, false)
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.volume, 0.4)
    assert.equal(full.muted, false)
    assert.equal(full.volume, 0.35)
    handlers.click({ target: dialog })
    assert.equal(hero.paused, false)
    assert.equal(hero.muted, true)
    assert.equal(hero.loop, true)
    assert.equal(hero.controls, false)
    assert.equal(heroButton.hidden, false)
    heroButton.click()
    assert.equal(hero.currentTime, 0)
    assert.equal(hero.muted, false)
    assert.equal(hero.loop, false)
    assert.equal(hero.volume, 0.4)
    assert.equal(heroButton.hidden, true)
})

test('closing a dialog plays only the previews the queue has already admitted', () => {
    const previews = [0, 1, 2, 3].map(() => shellVideo({ loopVideo: '' }))
    const calls = []
    const handlers = {}
    const full = {
        currentTime: 0,
        muted: true,
        loop: false,
        volume: 1,
        controls: true,
        paused: true,
        dataset: {},
        preload: 'none',
        readyState: 0,
        play: () => ((full.paused = false), Promise.resolve()),
        pause: () => {
            full.paused = true
        }
    }
    const dialog = {
        querySelector: () => full,
        showModal: () => calls.push('open'),
        close: () => (calls.push('close'), handlers.close()),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const tileButton = control({ videoDialogOpen: 'v1' })
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: (id) => (id === 'v1' ? dialog : null),
        querySelectorAll: (selector) => {
            if (selector === 'video') return [...previews, full]
            if (String(selector).includes('data-video-dialog-open')) return [tileButton]
            if (String(selector).includes('data-loop-video') || String(selector).includes('data-demo-video')) return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    full.ownerDocument = doc
    assert.equal(initDemoVideo(doc, win), true)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    assert.deepEqual(
        previews.map((preview) => preview.preload),
        ['auto', 'auto', 'none', 'none']
    )
    assert.deepEqual(
        previews.map((preview) => preview.calls.filter((call) => call === 'load').length),
        [1, 1, 0, 0]
    )
    for (const preview of previews) preview.calls.length = 0
    assert.equal(initVideoDialogs(doc), 1)
    tileButton.click()
    assert.equal(
        previews.every((preview) => preview.paused),
        true
    )
    handlers.click({ target: dialog })
    assert.deepEqual(
        previews.map((preview) => preview.calls.includes('play')),
        [true, true, false, false]
    )
    assert.equal(previews[2].preload, 'none')
    assert.equal(previews[3].preload, 'none')
    assert.equal(previews[2].readyState, 0)
    assert.equal(previews[3].readyState, 0)
})

test('canplaythrough during an open dialog admits the next preview without playing it', () => {
    const previews = [0, 1, 2].map(() => shellVideo({ loopVideo: '' }))
    const handlers = {}
    const full = {
        currentTime: 0,
        muted: true,
        loop: false,
        volume: 1,
        controls: true,
        paused: true,
        dataset: {},
        preload: 'none',
        readyState: 0,
        play: () => ((full.paused = false), Promise.resolve()),
        pause: () => {
            full.paused = true
        }
    }
    const dialog = {
        querySelector: () => full,
        showModal() {},
        close: () => handlers.close(),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const tileButton = control({ videoDialogOpen: 'v1' })
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: () => dialog,
        querySelectorAll: (selector) => {
            if (selector === 'video') return [...previews, full]
            if (String(selector).includes('data-video-dialog-open')) return [tileButton]
            if (String(selector).includes('data-loop-video') || String(selector).includes('data-demo-video')) return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    full.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    initVideoDialogs(doc)
    for (const preview of previews) preview.calls.length = 0
    tileButton.click()
    previews[0].emit('canplaythrough')
    assert.equal(previews[2].preload, 'auto')
    assert.equal(previews[2].calls.includes('load'), true)
    assert.equal(previews[2].calls.includes('play'), false)
    assert.equal(previews[2].paused, true)
    assert.equal(previews[1].calls.includes('play'), false)
})

test('an open dialog keeps a returning preview paused', () => {
    const preview = shellVideo({ loopVideo: '' })
    const handlers = {}
    const full = {
        currentTime: 0,
        muted: true,
        loop: false,
        volume: 1,
        controls: true,
        paused: true,
        dataset: {},
        preload: 'none',
        readyState: 0,
        play: () => ((full.paused = false), Promise.resolve()),
        pause: () => {
            full.paused = true
        }
    }
    const dialog = {
        querySelector: () => full,
        showModal() {},
        close: () => handlers.close(),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const tileButton = control({ videoDialogOpen: 'v1' })
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: () => dialog,
        querySelectorAll: (selector) => {
            if (selector === 'video') return [preview, full]
            if (String(selector).includes('data-video-dialog-open')) return [tileButton]
            if (String(selector).includes('data-loop-video') || String(selector).includes('data-demo-video')) return [preview]
            return []
        }
    }
    preview.ownerDocument = doc
    full.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb([{ target: preview, isIntersecting: true }])
    initVideoDialogs(doc)
    tileButton.click()
    preview.calls.length = 0
    playObserver.cb([{ target: preview, isIntersecting: true }])
    assert.equal(preview.calls.includes('play'), false)
    assert.equal(preview.paused, true)
    handlers.close()
    assert.equal(preview.calls.includes('play'), true)
    assert.equal(preview.paused, false)
    assert.equal(preview.muted, true)
})

test('a rejected hero play returns the silent preview and resumes an admitted loop', async () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    hero.play = () => {
        hero.calls.push('play')
        return Promise.reject(new Error('NotAllowedError'))
    }
    const tile = shellVideo({ loopVideo: '' })
    const previews = [hero, tile]
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        querySelectorAll: (selector) => {
            if (selector === 'video' || String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video'))
                return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    for (const preview of previews) preview.calls.length = 0
    heroButton.click()
    await Promise.resolve()
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.muted, true)
    assert.equal(hero.defaultMuted, true)
    assert.equal(hero.loop, true)
    assert.equal(hero.controls, false)
    assert.equal(tile.paused, false)
    assert.equal(tile.muted, true)
    assert.equal(tile.loop, true)
    assert.equal(tile.calls.includes('play'), true)
})

test('an error after a sounding hero play restores the button and muted previews', async () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    const tile = shellVideo({ loopVideo: '' })
    const previews = [hero, tile]
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        querySelectorAll: (selector) => {
            if (selector === 'video' || String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video'))
                return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    heroButton.click()
    await Promise.resolve()
    assert.equal(hero.paused, false)
    assert.equal(hero.muted, false)
    assert.equal(heroButton.hidden, true)
    for (const preview of previews) preview.calls.length = 0
    hero.emit('error')
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.muted, true)
    assert.equal(hero.defaultMuted, true)
    assert.equal(hero.loop, true)
    assert.equal(hero.controls, false)
    assert.equal(tile.paused, false)
    assert.equal(tile.muted, true)
    assert.equal(tile.loop, true)
    assert.equal(tile.calls.includes('play'), true)
})

test('an error on a non-narrating element does not end the current session', async () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    const tile = shellVideo({ loopVideo: '' })
    const full = shellVideo({})
    full.volume = 0.35
    const handlers = {}
    const dialog = {
        querySelector: () => full,
        showModal() {},
        close: () => handlers.close?.(),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const tileButton = control({ videoDialogOpen: 'v1' })
    const previews = [hero, tile]
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: () => dialog,
        querySelectorAll: (selector) => {
            if (selector === 'video') return [...previews, full]
            if (String(selector).includes('data-video-dialog-open')) return [tileButton]
            if (String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video')) return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    full.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    initVideoDialogs(doc)
    heroButton.click()
    await Promise.resolve()
    assert.equal(heroButton.hidden, true)
    assert.equal(hero.muted, false)
    assert.equal(hero.paused, false)
    tile.calls.length = 0
    tile.emit('error')
    assert.equal(heroButton.hidden, true)
    assert.equal(hero.muted, false)
    assert.equal(hero.paused, false)
    assert.equal(hero.controls, true)
    assert.equal(tile.paused, true)
    assert.equal(tile.calls.includes('play'), false)
    hero.currentTime = 4
    tileButton.click()
    await Promise.resolve()
    assert.equal(full.paused, false)
    assert.equal(full.muted, false)
    hero.emit('error')
    assert.equal(full.paused, false)
    assert.equal(full.muted, false)
    assert.equal(full.controls, true)
    assert.equal(hero.currentTime, 4)
    assert.equal(tile.paused, true)
    assert.equal(tile.calls.includes('play'), false)
})

test('a rejected dialog play resumes the previews it paused', async () => {
    const previews = [0, 1].map(() => shellVideo({ loopVideo: '' }))
    const handlers = {}
    const full = {
        currentTime: 0,
        muted: true,
        loop: false,
        volume: 0.35,
        controls: true,
        paused: true,
        dataset: {},
        preload: 'none',
        readyState: 0,
        play: () => Promise.reject(new Error('NotAllowedError')),
        pause: () => {
            full.paused = true
        }
    }
    const dialog = {
        querySelector: () => full,
        showModal() {},
        close: () => handlers.close?.(),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const tileButton = control({ videoDialogOpen: 'v1' })
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: () => dialog,
        querySelectorAll: (selector) => {
            if (selector === 'video') return [...previews, full]
            if (String(selector).includes('data-video-dialog-open')) return [tileButton]
            if (String(selector).includes('data-loop-video') || String(selector).includes('data-demo-video')) return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    full.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    initVideoDialogs(doc)
    for (const preview of previews) preview.calls.length = 0
    tileButton.click()
    await Promise.resolve()
    assert.equal(full.paused, true)
    assert.equal(full.volume, 0.35)
    assert.deepEqual(
        previews.map((preview) => preview.paused),
        [false, false]
    )
    assert.deepEqual(
        previews.map((preview) => preview.muted),
        [true, true]
    )
    assert.deepEqual(
        previews.map((preview) => preview.calls.includes('play')),
        [true, true]
    )
})

test('a pending hero play does not resume previews after a dialog takes over', async () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    let rejectPlay = null
    let pendingPlay = null
    hero.play = () => {
        hero.calls.push('play')
        hero.paused = false
        pendingPlay = new Promise((resolve, reject) => {
            rejectPlay = reject
        })
        return pendingPlay
    }
    hero.pause = () => {
        hero.paused = true
        hero.calls.push('pause')
        if (!rejectPlay) return
        const reject = rejectPlay
        rejectPlay = null
        const error = new Error('The play() request was interrupted by a call to pause().')
        error.name = 'AbortError'
        reject(error)
    }
    const tile = shellVideo({ loopVideo: '' })
    const handlers = {}
    const full = {
        currentTime: 0,
        muted: true,
        loop: false,
        volume: 1,
        controls: true,
        paused: true,
        dataset: {},
        preload: 'auto',
        readyState: 4,
        play: () => ((full.paused = false), (full.muted = false), Promise.resolve()),
        pause: () => {
            full.paused = true
        }
    }
    const dialog = {
        querySelector: () => full,
        showModal() {},
        close: () => handlers.close?.(),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const tileButton = control({ videoDialogOpen: 'v1' })
    const previews = [hero, tile]
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: () => dialog,
        querySelectorAll: (selector) => {
            if (selector === 'video') return [...previews, full]
            if (String(selector).includes('data-video-dialog-open')) return [tileButton]
            if (String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video')) return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    full.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    heroButton.click()
    assert.equal(hero.paused, false)
    tile.calls.length = 0
    initVideoDialogs(doc)
    tileButton.click()
    const error = await pendingPlay.then(
        () => null,
        (err) => err
    )
    assert.equal(error.name, 'AbortError')
    assert.equal(full.paused, false)
    assert.equal(full.muted, false)
    assert.equal(tile.calls.filter((call) => call === 'play').length, 0)
    assert.equal(tile.paused, true)
})

test('scrolling the sounding hero off screen ends the sound session', async () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    const tile = shellVideo({ loopVideo: '' })
    const previews = [hero, tile]
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        querySelectorAll: (selector) => {
            if (selector === 'video' || String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video'))
                return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    initDemoVideo(doc, win)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    heroButton.click()
    await Promise.resolve()
    assert.equal(hero.paused, false)
    assert.equal(hero.muted, false)
    assert.equal(heroButton.hidden, true)
    tile.calls.length = 0
    playObserver.cb([{ target: hero, isIntersecting: false }])
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.muted, true)
    assert.equal(hero.loop, true)
    assert.equal(hero.controls, false)
    assert.equal(tile.calls.includes('play'), true)
    assert.equal(tile.paused, false)
    assert.equal(tile.muted, true)
    playObserver.cb([{ target: hero, isIntersecting: true }])
    assert.equal(hero.muted, true)
    assert.equal(hero.loop, true)
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.controls, false)
})

test('scrolling a sounding hero off screen ends narration when autoplay is off', async () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    const tile = shellVideo({ loopVideo: '' })
    const previews = [hero, tile]
    const observers = []
    const win = {
        matchMedia: (query) => ({ matches: query.includes('max-width') }),
        navigator: { connection: { saveData: false } },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                this.targets = []
                observers.push(this)
            }
            observe(target) {
                this.targets.push(target)
            }
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        querySelectorAll: (selector) => {
            if (selector === 'video' || String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video'))
                return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    assert.equal(initDemoVideo(doc, win), false)
    assert.equal(observers.length, 1)
    assert.equal(observers[0].options.threshold, 0.5)
    assert.equal(observers[0].options.rootMargin, undefined)
    assert.deepEqual(observers[0].targets, [hero])
    assert.equal(hero.calls.includes('load'), false)
    assert.equal(tile.preload, 'none')
    assert.equal(tile.calls.includes('load'), false)
    heroButton.click()
    await Promise.resolve()
    assert.equal(hero.paused, false)
    assert.equal(hero.muted, false)
    assert.equal(heroButton.hidden, true)
    hero.calls.length = 0
    tile.calls.length = 0
    observers[0].cb([{ target: hero, isIntersecting: false }])
    assert.equal(hero.paused, true)
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.muted, true)
    assert.equal(hero.defaultMuted, true)
    assert.equal(hero.loop, true)
    assert.equal(hero.controls, false)
    assert.equal(hero.calls.includes('load'), false)
    assert.equal(tile.calls.includes('play'), false)
    assert.equal(tile.calls.includes('load'), false)
    observers[0].cb([{ target: hero, isIntersecting: true }])
    assert.equal(hero.muted, true)
    assert.equal(hero.paused, true)
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.controls, false)
    assert.equal(hero.calls.includes('play'), false)
})

test('a rejected replay after a parked hero reloads the poster', async () => {
    const source = {
        removed: false,
        remove() {
            this.removed = true
        }
    }
    const attached = [source]
    const video = shellVideo({ demoVideo: '' })
    const button = control({ playWithSound: '' })
    video.nextElementSibling = button
    video.querySelectorAll = () => attached.filter((item) => !item.removed)
    video.appendChild = (node) => {
        node.removed = false
    }
    let plays = 0
    video.play = () => {
        plays += 1
        video.calls.push('play')
        if (plays > 1) return Promise.reject(new Error('NotAllowedError'))
        video.paused = false
        return Promise.resolve()
    }
    const loads = []
    video.load = () => {
        loads.push(video.querySelectorAll('source').length)
    }
    const win = {
        matchMedia: () => ({ matches: true }),
        navigator: { connection: { saveData: false } },
        addEventListener() {}
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        querySelectorAll: () => [video]
    }
    video.ownerDocument = doc
    initDemoVideo(doc, win)
    button.click()
    await Promise.resolve()
    assert.deepEqual(loads, [])
    video.emit('ended')
    assert.deepEqual(loads, [0])
    assert.equal(source.removed, true)
    button.click()
    await Promise.resolve()
    assert.equal(source.removed, true)
    assert.deepEqual(loads, [0, 0])
    assert.equal(button.hidden, false)
    assert.equal(video.muted, true)
    assert.equal(video.controls, false)
})

test('a refused dialog play keeps its sources so the next open plays the file', async () => {
    const source = {
        removed: false,
        remove() {
            this.removed = true
        }
    }
    const attached = [source]
    let plays = 0
    const loads = []
    const full = {
        currentTime: 0,
        muted: true,
        loop: true,
        volume: 0.35,
        controls: true,
        paused: true,
        dataset: {},
        preload: 'none',
        readyState: 0,
        querySelectorAll: (selector) => (String(selector) === 'source' ? attached.filter((item) => !item.removed) : []),
        appendChild(node) {
            node.removed = false
        },
        load() {
            loads.push(full.querySelectorAll('source').length)
        },
        play() {
            plays += 1
            if (plays === 1) return Promise.reject(new Error('NotAllowedError'))
            full.paused = false
            return Promise.resolve()
        },
        pause() {
            full.paused = true
        }
    }
    const dialog = {
        querySelector: () => full,
        showModal() {},
        close() {},
        addEventListener() {}
    }
    const linkHandlers = {}
    const link = {
        dataset: { videoDialogOpen: 'v1' },
        addEventListener(type, fn) {
            ;(linkHandlers[type] ||= []).push(fn)
        },
        click() {
            for (const fn of linkHandlers.click || []) fn({ preventDefault() {} })
        }
    }
    const win = {
        matchMedia: (query) => ({ matches: query.includes('max-width') }),
        navigator: { connection: { saveData: false } },
        addEventListener() {},
        IntersectionObserver: class {
            constructor() {}
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        getElementById: () => dialog,
        querySelectorAll: (selector) => {
            if (selector === 'video') return [full]
            if (String(selector).includes('data-video-dialog-open')) return [link]
            return []
        }
    }
    full.ownerDocument = doc
    assert.equal(initDemoVideo(doc, win), false)
    initVideoDialogs(doc)
    linkHandlers.pointerenter[0]()
    assert.deepEqual(loads, [1])
    assert.equal(source.removed, false)
    link.click()
    await Promise.resolve()
    assert.equal(plays, 1)
    assert.equal(full.paused, true)
    assert.equal(source.removed, false)
    assert.deepEqual(loads, [1])
    link.click()
    await Promise.resolve()
    assert.equal(plays, 2)
    assert.equal(full.paused, false)
    assert.equal(full.muted, false)
    assert.equal(source.removed, false)
    assert.deepEqual(loads, [1])
})

test('ending the hero narration resumes on-screen loops the queue has already admitted', () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    const tiles = [0, 1, 2].map(() => shellVideo({ loopVideo: '' }))
    const previews = [hero, ...tiles]
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    const doc = {
        hidden: false,
        visibilityState: 'visible',
        defaultView: win,
        addEventListener() {},
        querySelectorAll: (selector) => {
            if (selector === 'video') return previews
            if (String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video')) return previews
            return []
        }
    }
    for (const preview of previews) preview.ownerDocument = doc
    assert.equal(initDemoVideo(doc, win), true)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    assert.deepEqual(
        previews.map((preview) => preview.preload),
        ['auto', 'auto', 'none', 'none']
    )
    for (const preview of previews) preview.calls.length = 0
    heroButton.click()
    assert.equal(
        tiles.every((tile) => tile.paused),
        true
    )
    hero.emit('ended')
    assert.equal(hero.muted, true)
    assert.equal(hero.loop, true)
    assert.equal(heroButton.hidden, false)
    assert.equal(hero.calls.includes('play'), true)
    assert.equal(tiles[0].calls.includes('play'), true)
    assert.equal(tiles[0].muted, true)
    assert.equal(tiles[0].loop, true)
    assert.equal(tiles[1].calls.includes('play'), false)
    assert.equal(tiles[2].calls.includes('play'), false)
    assert.equal(tiles[1].paused, true)
    assert.equal(tiles[2].paused, true)
    assert.equal(tiles[1].preload, 'none')
    assert.equal(tiles[2].preload, 'none')
})

test('after the hero ends on screen the silent preview returns with the play button', () => {
    const video = shellVideo({ demoVideo: '' })
    const button = control({ playWithSound: '' })
    video.nextElementSibling = button
    const observers = []
    const doc = { hidden: false, visibilityState: 'visible', querySelectorAll: () => [video], addEventListener() {} }
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: {} },
        addEventListener() {},
        IntersectionObserver: class {
            constructor(cb, options) {
                this.cb = cb
                this.options = options || {}
                observers.push(this)
            }
            observe() {}
        }
    }
    video.ownerDocument = doc
    doc.defaultView = win
    assert.equal(initDemoVideo(doc, win), true)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb([{ target: video, isIntersecting: true }])
    const loadsBefore = video.calls.filter((call) => call === 'load').length
    video.currentTime = 3.4
    video.muted = true
    video.loop = true
    video.volume = 0.4
    button.click()
    assert.equal(video.currentTime, 0)
    assert.equal(video.muted, false)
    assert.equal(video.loop, false)
    assert.equal(video.volume, 0.4)
    assert.equal(button.hidden, true)
    assert.equal(video.calls.filter((call) => call === 'load').length, loadsBefore)
    video.emit('ended')
    assert.equal(button.hidden, false)
    assert.equal(video.muted, true)
    assert.equal(video.loop, true)
    assert.equal(video.controls, false)
    assert.equal(video.currentTime, 0)
    assert.equal(video.paused, false)
})

test('a tile dialog starts at 0 with sound every time it opens, and closing pauses', () => {
    const calls = []
    const handlers = {}
    const full = {
        currentTime: 6.5,
        muted: true,
        loop: true,
        volume: 0.35,
        controls: true,
        preload: 'none',
        play: () => (calls.push('play'), Promise.resolve()),
        pause: () => calls.push('pause'),
        load: () => calls.push('load')
    }
    const dialog = {
        querySelector: () => full,
        showModal: () => calls.push('open'),
        close: () => (calls.push('close'), handlers.close()),
        addEventListener: (type, fn) => (handlers[type] = fn)
    }
    const loop = shellVideo({ loopVideo: '' })
    const button = control({ playWithSound: '', videoDialogOpen: 'v1' })
    const link = control({ videoDialogOpen: 'v1' })
    loop.nextElementSibling = button
    button.previousElementSibling = loop
    link.previousElementSibling = button
    const doc = {
        querySelectorAll: () => [button, link],
        getElementById: (id) => (id === 'v1' ? dialog : null)
    }
    assert.equal(initVideoDialogs(doc), 2)
    button.click()
    assert.equal(full.currentTime, 0)
    assert.equal(full.muted, false)
    assert.equal(full.loop, false)
    assert.equal(full.volume, 0.35)
    assert.equal(full.controls, true)
    full.currentTime = 4
    handlers.click({ target: dialog })
    assert.deepEqual(calls, ['open', 'pause', 'play', 'close', 'pause'])
    link.click()
    assert.equal(full.currentTime, 0)
    assert.equal(full.muted, false)
    assert.equal(full.loop, false)
    full.currentTime = 2
    loop.click()
    assert.equal(full.currentTime, 0)
    assert.equal(calls.filter((call) => call === 'load').length, 0)
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
