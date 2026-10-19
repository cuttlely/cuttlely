import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canAutoplay, initClipSlots, initDemoVideo, initVideoDialogs } from '../src/scripts/demo-video.mjs'

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

test('first paint parks sources and does not fetch or play', () => {
    const { doc, win, calls, list, show } = fakes({ videos: 4 })
    for (const video of list) {
        video.dataset = { loopVideo: '' }
        const source = {
            removed: false,
            remove() {
                this.removed = true
            }
        }
        video.querySelectorAll = () => (source.removed ? [] : [source])
    }
    assert.equal(initDemoVideo(doc, win), false)
    show(0, true)
    show(1, true)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('play') || call.startsWith('load') || call.startsWith('fetch')),
        []
    )
    assert.equal(
        list.every((video) => video.preload === 'none'),
        true
    )
})

test('after a play click, one on-screen tile loop starts and a second click replaces it', () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    const tiles = [0, 1].map(() => shellVideo({ loopVideo: '' }))
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
            if (selector === 'video') return [hero, ...tiles]
            if (String(selector).includes('data-demo-video') || String(selector).includes('data-loop-video')) return [hero, ...tiles]
            return []
        }
    }
    hero.ownerDocument = doc
    for (const tile of tiles) tile.ownerDocument = doc
    assert.equal(initDemoVideo(doc, win), false)
    observers[0].cb([hero, ...tiles].map((target) => ({ target, isIntersecting: true })))
    assert.equal(
        tiles.every((tile) => tile.paused && tile.preload === 'none'),
        true
    )
    heroButton.click()
    hero.emit('ended')
    assert.equal(tiles[0].paused, false)
    assert.equal(tiles[0].muted, true)
    assert.equal(tiles[0].loop, true)
    assert.equal(tiles[1].paused, true)
    observers[0].cb([{ target: tiles[0], isIntersecting: false }])
    assert.equal(tiles[0].paused, true)
    observers[0].cb([{ target: tiles[1], isIntersecting: true }])
    assert.equal(tiles[1].paused, false)
    assert.equal(tiles[1].muted, true)
    assert.equal(tiles[0].paused, true)
})

test('Save-Data never starts a tile loop after a play click', () => {
    const hero = shellVideo({ demoVideo: '' })
    const heroButton = control({ playWithSound: '' })
    hero.nextElementSibling = heroButton
    const tile = shellVideo({ loopVideo: '' })
    const observers = []
    const win = {
        matchMedia: () => ({ matches: false }),
        navigator: { connection: { saveData: true } },
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
                return [hero, tile]
            return []
        }
    }
    hero.ownerDocument = doc
    tile.ownerDocument = doc
    assert.equal(initDemoVideo(doc, win), false)
    if (observers[0]) observers[0].cb([hero, tile].map((target) => ({ target, isIntersecting: true })))
    heroButton.click()
    hero.emit('ended')
    assert.equal(tile.paused, true)
    assert.equal(tile.preload, 'none')
    assert.equal(tile.calls.includes('play'), false)
    assert.equal(tile.calls.includes('load'), false)
})

test('scrolling never starts a loop download before a play click', () => {
    const { doc, win, calls, list, showAll, inFlight, peak } = fakes({ videos: 7 })
    for (const video of list) video.dataset = { loopVideo: '' }
    assert.equal(initDemoVideo(doc, win), false)
    showAll([6, 4, 5, 3, 2, 1, 0])
    assert.equal(inFlight(), 0)
    assert.equal(peak(), 0)
    assert.deepEqual(
        calls.filter((call) => call.startsWith('load') || call.startsWith('play') || call.startsWith('fetch')),
        []
    )
})

test('leaves the videos alone for reduced motion, small screens, Save-Data, no videos or no IntersectionObserver', () => {
    for (const options of [{ reduced: true }, { small: true }, { saveData: true }, { videos: 0 }, { hasObserver: false }]) {
        const { doc, win, calls, list } = fakes(options)
        assert.equal(initDemoVideo(doc, win), false, JSON.stringify(options))
        assert.deepEqual(
            calls.filter((call) => call.startsWith('play') || call.startsWith('load') || call.startsWith('fetch')),
            []
        )
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

function attachSource(video) {
    const source = {
        removed: false,
        remove() {
            this.removed = true
        }
    }
    const attached = [source]
    video.querySelectorAll = () => attached.filter((item) => !item.removed)
    video.appendChild = (node) => {
        node.removed = false
    }
    return source
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
        'ab-test-every-change-before-it-goes-live',
        'made-for-real-teams',
        'agent-teams-that-power-your-apps',
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
    for (const id of [
        'chat-with-a-team-in-minutes',
        'test-every-change-before-it-goes-live',
        'ship-changes-safely-draft-compare-publish-roll-back',
        'run-it-your-way'
    ]) {
        assert.match(src, new RegExp(`id="${id}"`))
    }
    const tools = src.slice(src.indexOf('const tools'), src.indexOf('const installs'))
    assert.equal(tools.includes("slug: 'testing'"), false)
    assert.equal(tools.includes('Test before you publish'), false)
    assert.match(tools, /slug: 'chatflows'/)
    assert.equal((src.match(/\/media\/products\/testing\.mp4/g) || []).length, 1)
    assert.equal((src.match(/aria-label="Play the testing video with sound"/g) || []).length, 1)
})

test('the demo follows the hero, the case study follows the demo, then the A/B section, and the demo copy shares a row with its video', () => {
    const src = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/styles/site.css', import.meta.url), 'utf8')
    assert.match(src, /<h2 id="test-every-change-title" class="cl-display">A\/B test every change before it goes live<\/h2>/)
    assert.match(src, /<h2 id="case-title" class="cl-display">Not the obvious answer<\/h2>/)
    const proof = src.indexOf('class="cl-pillars"')
    const demo = src.indexOf('<section id="watch-a-team-resolve-a-complaint"')
    const caseStudy = src.indexOf('<section id="one-complaint-three-specialists"')
    const ab = src.indexOf('<section id="ab-test-every-change-before-it-goes-live"')
    assert.ok(proof < demo && demo < caseStudy && caseStudy < ab)
    assert.equal(src.slice(proof, demo).match(/<section/g), null, 'nothing sits between the pillars and the demo')
    assert.equal(src.slice(demo + 1, caseStudy).match(/<section/g), null, 'nothing sits between the demo and the case study')
    assert.equal(src.slice(caseStudy + 1, ab).match(/<section/g), null, 'nothing sits between the case study and the A/B section')
    const showcase = src.slice(demo, caseStudy)
    assert.ok(showcase.indexOf('class="cl-showcase-copy"') < showcase.indexOf('class="cl-demo-window"'), 'copy comes before the video')
    // An anchor span in the flow takes the first grid cell and pushes the copy onto a second row.
    assert.match(css, /\.cl-home \.cl-anchor \{\s*position: absolute;/)
})

test('the video dialog centres itself in the viewport', () => {
    const css = readFileSync(new URL('../src/styles/site.css', import.meta.url), 'utf8')
    // Starlight's reset sets `* { margin: 0 }`, which pins a modal dialog to the top-left corner.
    const rule = css.match(/\n\.cl-video-dialog \{([^}]*)\}/)[1]
    assert.match(rule, /\n\s*margin: auto;/)
    assert.equal(/position:/.test(rule), false, 'the native modal positioning stays in charge')
})

test('Made for real teams follows the A/B section, links each card to a guide, and stacks on a phone', () => {
    const src = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/styles/site.css', import.meta.url), 'utf8')
    const ab = src.indexOf('<section id="ab-test-every-change-before-it-goes-live"')
    const teams = src.indexOf('<section id="made-for-real-teams"')
    const agentTeams = src.indexOf('<section id="agent-teams-that-power-your-apps"')
    assert.ok(ab < teams && teams < agentTeams)
    assert.equal(src.slice(ab + 1, teams).match(/<section/g), null, 'nothing sits between the A/B section and Made for real teams')
    assert.match(src, /<h2 id="real-teams-title" class="cl-display">Made for real teams<\/h2>/)
    const features = src.slice(src.indexOf('const teamFeatures'), src.indexOf('const installs'))
    const hrefs = [...features.matchAll(/href: '([^']+)'/g)].map((m) => m[1])
    assert.ok(hrefs.length >= 4 && hrefs.length <= 6, `${hrefs.length} cards`)
    for (const href of hrefs) assert.match(href, /^\/docs\/how-to\//)
    assert.match(css, /\.cl-team-cards \{\s*max-width: 68rem;\s*grid-template-columns: minmax\(0, 1fr\);/)
})

test('the light home page colour tokens and rules apply only to the light theme', () => {
    const brand = readFileSync(new URL('../src/styles/brand.css', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/styles/site.css', import.meta.url), 'utf8')
    const light = brand.slice(brand.indexOf(":root[data-theme='light'] {"))
    const dark = brand.slice(0, brand.indexOf(":root[data-theme='light'] {"))
    for (const token of [
        '--cuttlely-wash:',
        '--cuttlely-chip:',
        '--cuttlely-chip-ink:',
        '--cuttlely-card-border:',
        '--cuttlely-card-shadow:',
        '--cuttlely-gradient-headline:'
    ]) {
        assert.ok(light.includes(token), token)
        assert.equal(dark.includes(token), false, `${token} stays out of the dark theme`)
    }
    for (const line of css.split('\n').filter((l) => /var\(--cuttlely-(wash|chip|card-border|card-shadow|gradient-headline)/.test(l))) {
        const rule = css.slice(0, css.indexOf(line))
        const selector = rule.slice(rule.lastIndexOf('}') + 1)
        assert.match(selector, /:root\[data-theme='light'\]/, line.trim())
    }
})

test('no two light-theme tinted bands sit next to each other on the home page', () => {
    const src = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/styles/site.css', import.meta.url), 'utf8')
    const order = [...src.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1])
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // Every :is( list, whatever comes before it (:root, section, a class), split on its top-level commas.
    const lists = []
    for (const m of rules.matchAll(/:is\(/g)) {
        let depth = 1
        let i = m.index + m[0].length
        const start = i
        for (; i < rules.length && depth; i++) depth += rules[i] === '(' ? 1 : rules[i] === ')' ? -1 : 0
        assert.equal(depth, 0, `unclosed :is( at offset ${m.index}`)
        const parts = []
        let level = 0
        let part = ''
        for (const ch of rules.slice(start, i - 1)) {
            if (ch === ',' && level === 0) {
                parts.push(part.trim())
                part = ''
                continue
            }
            level += ch === '(' ? 1 : ch === ')' ? -1 : 0
            part += ch
        }
        parts.push(part.trim())
        if (parts.some((s) => s.includes('#'))) lists.push(parts)
    }
    for (const list of lists)
        assert.ok(
            list.every((s) => /^#[\w-]+$/.test(s)),
            `band list has a selector other than a section id: ${list.join(', ')}`
        )
    const ids = lists.map((list) => list.map((s) => s.slice(1)).sort())
    assert.ok(ids.length >= 3, 'band, wash and border selector lists')
    for (const list of ids) assert.deepEqual(list, ids[0], 'every band selector list names the same sections')
    // A section id anywhere else in the stylesheet is a band this test did not parse.
    for (const id of order) {
        const uses = rules.match(new RegExp(`#${id}(?![\\w-])`, 'g'))?.length || 0
        const parsed = ids.filter((list) => list.includes(id)).length
        assert.equal(uses, parsed, `#${id} is used outside an :is() band list`)
    }
    const banded = new Set(ids.flat())
    for (const id of banded) assert.ok(order.includes(id), id)
    for (let i = 1; i < order.length; i++) {
        assert.ok(!(banded.has(order[i - 1]) && banded.has(order[i])), `${order[i - 1]} and ${order[i]} are both tinted`)
    }
})

test('the light hero headline gradient keeps 3.5:1 on the darkest point of the hero wash, and the wash fades out', () => {
    const brand = readFileSync(new URL('../src/styles/brand.css', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/styles/site.css', import.meta.url), 'utf8')
    const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    const stops = brand.match(/--cuttlely-gradient-headline: linear-gradient\(90deg, ([^)]+)\);/)[1].split(', ')
    assert.equal(stops[0], '#6a3df2', 'the headline starts on the brand violet')

    const wash = css.match(/:root\[data-theme='light'\] \.cl-hero::before \{([^}]+)\}/)[1]
    assert.match(wash, /mask-image: linear-gradient\(180deg, #000 \d+%, transparent 100%\)/, 'the wash fades to the page')
    // The glows sit in opposite corners, so the darkest point is one glow at full strength over the darker base end.
    const base = wash
        .match(/linear-gradient\(180deg, (#[0-9a-f]{6}) 0%, (#[0-9a-f]{6}) 100%\)/)
        .slice(1)
        .map(hex)
    const under = base.sort((a, b) => lum(a) - lum(b))[0]
    const glows = [...wash.matchAll(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/g)].map((m) => [m.slice(1, 4).map(Number), +m[4]])
    assert.equal(glows.length, 3)
    for (const [rgb, a] of glows) {
        const bg = under.map((c, i) => rgb[i] * a + c * (1 - a))
        for (const stop of stops) {
            const ratio = (lum(bg) + 0.05) / (lum(hex(stop)) + 0.05)
            assert.ok(ratio >= 3.5, `${stop} under the rgba(${rgb}, ${a}) glow is ${ratio.toFixed(2)}:1`)
        }
    }
    assert.match(
        css,
        /:root\[data-theme='light'\] \.cl-hero-title \.cl-gradient-text \{\s*background-image: var\(--cuttlely-gradient-headline\);/
    )
})

test('the home page hero uses the production message house', () => {
    const lead = 'Drag-and-drop agents with real governance and lean context. Open source, Apache-2.0.'
    const hero = readFileSync(new URL('../src/components/Hero.astro', import.meta.url), 'utf8')
    const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8')
    const heroLead = hero.slice(hero.indexOf('<p class="cl-hero-lead">') + 24, hero.indexOf('</p>', hero.indexOf('cl-hero-lead')))
    assert.match(hero, /The visual agent builder,/)
    assert.match(hero, /ready for production\./)
    assert.equal(heroLead.replace(/\s+/g, ' ').trim(), lead)
    assert.doesNotMatch(hero, /picks up where/)
    assert.doesNotMatch(hero, /cl-hero-proof/)
    assert.ok(hero.includes('href="/flowise/"'))
    assert.ok(hero.includes('Coming from Flowise?'))
    assert.ok(page.includes(`title: 'Cuttlely: the visual agent builder, ready for production'`))
    assert.match(page, /Governance\./)
    assert.match(page, /Safe drafts and replay\./)
    assert.match(page, /Lean context\./)
    assert.match(page, /Lower token cost\./)
    assert.match(page, /Build agent teams\./)
    assert.match(page, /Import your Flowise JSON/)
})

test('the home page ends with the sign-off line below the site footer, and other pages do not', () => {
    const footer = readFileSync(new URL('../src/components/Footer.astro', import.meta.url), 'utf8')
    assert.ok(footer.indexOf('<SiteFooter />') < footer.indexOf('cl-signoff'))
    assert.match(footer, /const isHome = Astro\.url\.pathname === '\/'/)
    assert.match(footer, /\{isHome && <p class="cl-signoff not-content">Cuttlely · Cute name, serious work\.<\/p>\}/)
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
    assert.equal(source.removed, true)
    button.click()
    assert.equal(source.removed, false)
    assert.deepEqual(loads, [1])
    video.emit('ended')
    assert.deepEqual(loads, [1, 0])
    assert.equal(source.removed, true)
    assert.equal(button.hidden, false)
    button.click()
    assert.equal(source.removed, false)
    assert.deepEqual(loads, [1, 0, 1])
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
    assert.equal(initDemoVideo(doc, win), false)
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
    assert.equal(hero.paused, true)
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
    assert.equal(initDemoVideo(doc, win), false)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    assert.deepEqual(
        previews.map((preview) => preview.preload),
        ['none', 'none', 'none', 'none']
    )
    assert.deepEqual(
        previews.map((preview) => preview.calls.filter((call) => call === 'load').length),
        [0, 0, 0, 0]
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
        [true, false, false, false]
    )
    assert.equal(previews[1].preload, 'none')
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
    assert.equal(previews[2].preload, 'none')
    assert.equal(previews[2].calls.includes('load'), false)
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
        [false, true]
    )
    assert.deepEqual(
        previews.map((preview) => preview.muted),
        [true, true]
    )
    assert.deepEqual(
        previews.map((preview) => preview.calls.includes('play')),
        [true, false]
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
    const heroSource = attachSource(hero)
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
    assert.equal(heroSource.removed, true)
    assert.equal(hero.calls.includes('load'), true)
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
    const heroSource = attachSource(hero)
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
    assert.deepEqual(observers[0].targets, [hero, tile])
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
    assert.equal(heroSource.removed, true)
    assert.equal(hero.calls.includes('load'), true)
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
    assert.equal(source.removed, true)
    button.click()
    await Promise.resolve()
    assert.deepEqual(loads, [1])
    video.emit('ended')
    assert.deepEqual(loads, [1, 0])
    assert.equal(source.removed, true)
    button.click()
    await Promise.resolve()
    assert.equal(source.removed, true)
    assert.deepEqual(loads, [1, 0, 1, 0])
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
    assert.equal(source.removed, true)
    assert.equal(linkHandlers.pointerenter, undefined)
    assert.deepEqual(loads, [])
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
    assert.equal(initDemoVideo(doc, win), false)
    const playObserver = observers.find((observer) => observer.options.threshold === 0.5)
    playObserver.cb(previews.map((target) => ({ target, isIntersecting: true })))
    assert.deepEqual(
        previews.map((preview) => preview.preload),
        ['none', 'none', 'none', 'none']
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
    assert.equal(initDemoVideo(doc, win), false)
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
    assert.equal(video.paused, true)
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

test('the dialog video does not prefetch on pointerenter, focus or pointerdown', () => {
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
    assert.equal(linkHandlers.pointerenter, undefined)
    assert.equal(linkHandlers.focus, undefined)
    assert.equal(linkHandlers.pointerdown, undefined)
    assert.equal(video.preload, 'none')
    assert.deepEqual(calls, [])
})

test('the Watch with sound chip and its length read at 5:1 or better on the hover fill', () => {
    const css = readFileSync(new URL('../src/styles/site.css', import.meta.url), 'utf8')
    const brand = readFileSync(new URL('../src/styles/brand.css', import.meta.url), 'utf8')
    const rule = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/g, ',\\s*')
        const found = css.match(new RegExp(`\\n${escaped} \\{([^}]*)\\}`))
        assert.ok(found, `${selector} has a rule`)
        return found[1]
    }
    const hover = rule('.cl-tile-play:hover,\n.cl-tile-play:focus-visible')
    const token = hover.match(/background: var\((--[\w-]+)\);/)[1]
    const fill = brand.match(new RegExp(`:root \\{[^}]*${token}: (#[0-9a-f]{6});`))[1]
    const label = hover.match(/color: (#[0-9a-f]{6});/)[1]
    const lengthOpacity = Number(
        rule('.cl-tile-play:hover .cl-tile-play-length,\n.cl-tile-play:focus-visible .cl-tile-play-length').match(/opacity: ([\d.]+);/)[1]
    )
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const blend = (top, bottom, alpha) => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha))
    const lum = (c) => {
        const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    assert.ok(contrast(rgb(label), rgb(fill)) >= 5, 'chip label on the hover fill')
    assert.ok(contrast(blend(rgb(label), rgb(fill), lengthOpacity), rgb(fill)) >= 5, 'length on the hover fill')
})

test('a clip slot with no source stays on the poster until play has files to fetch', () => {
    const button = { disabled: false, addEventListener() {} }
    const poster = { hidden: false }
    const video = {
        hidden: true,
        dataset: { srcWebm: '', srcMp4: '' },
        querySelector: () => null,
        appendChild() {},
        ownerDocument: { querySelectorAll: () => [], createElement: () => ({}) }
    }
    const stage = {
        matches: () => false,
        querySelector(sel) {
            if (sel === 'video') return video
            if (sel === '[data-play-with-sound]') return button
            if (sel === '[data-clip-poster]') return poster
            return null
        }
    }
    const doc = { querySelectorAll: () => [stage], createElement: () => ({}) }
    assert.equal(initClipSlots(doc), 0)
    assert.equal(button.disabled, true)
    assert.equal(poster.hidden, false)
})

test('a clip slot attaches sources and plays only after click', () => {
    const listeners = {}
    const sources = []
    const button = {
        disabled: true,
        addEventListener(type, fn) {
            listeners[type] = fn
        }
    }
    const poster = { hidden: false }
    const video = {
        hidden: true,
        dataset: { srcWebm: '/media/clip.webm', srcMp4: '/media/clip.mp4' },
        querySelector: (sel) => (sel === 'source' ? sources[0] || null : null),
        querySelectorAll: (sel) => (sel === 'source' ? sources : []),
        appendChild(node) {
            sources.push(node)
        },
        ownerDocument: null,
        loop: true,
        defaultMuted: true,
        muted: true,
        controls: false,
        currentTime: 0,
        play() {
            return Promise.resolve()
        },
        addEventListener() {}
    }
    const doc = {
        querySelectorAll: (sel) => {
            if (sel === '[data-clip-slot]') return [stage]
            if (sel === 'video') return [video]
            return []
        },
        createElement: () => ({ src: '', type: '' })
    }
    video.ownerDocument = doc
    const stage = {
        matches: () => false,
        querySelector(sel) {
            if (sel === 'video') return video
            if (sel === '[data-play-with-sound]') return button
            if (sel === '[data-clip-poster]') return poster
            return null
        }
    }
    assert.equal(initClipSlots(doc), 1)
    assert.equal(button.disabled, false)
    assert.equal(sources.length, 0)
    listeners.click()
    assert.equal(sources.length, 2)
    assert.equal(poster.hidden, true)
    assert.equal(video.hidden, false)
})

test('a clip slot with parked sources still counts as ready to play', () => {
    const listeners = {}
    const source = {
        removed: false,
        remove() {
            this.removed = true
        }
    }
    const button = {
        disabled: true,
        addEventListener(type, fn) {
            listeners[type] = fn
        }
    }
    const video = {
        hidden: false,
        dataset: {},
        querySelector: (sel) => (sel === 'source' && !source.removed ? source : null),
        querySelectorAll: (sel) => (sel === 'source' && !source.removed ? [source] : []),
        appendChild() {
            source.removed = false
        },
        ownerDocument: null,
        preload: 'none',
        loop: true,
        defaultMuted: true,
        muted: true,
        controls: false,
        currentTime: 0,
        readyState: 0,
        load() {},
        play() {
            return Promise.resolve()
        },
        pause() {},
        addEventListener() {}
    }
    const doc = {
        querySelectorAll: (sel) => {
            if (sel === '[data-clip-slot]') return [stage]
            if (sel === 'video') return [video]
            return []
        },
        createElement: () => ({ src: '', type: '' })
    }
    video.ownerDocument = doc
    const stage = {
        matches: () => false,
        querySelector(sel) {
            if (sel === 'video') return video
            if (sel === '[data-play-with-sound]') return button
            return null
        }
    }
    assert.equal(initDemoVideo(doc, {}), false)
    assert.equal(source.removed, true)
    assert.equal(initClipSlots(doc), 1)
    assert.equal(button.disabled, false)
    listeners.click()
    assert.equal(source.removed, false)
})
