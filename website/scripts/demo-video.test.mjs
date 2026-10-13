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
