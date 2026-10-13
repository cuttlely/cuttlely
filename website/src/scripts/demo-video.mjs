// The home page videos: the narrated demo and the short loops on the product tiles. Loaded from the footer script, a
// same-origin module, so the site CSP needs no new hash. A centred play button starts each preview from the beginning
// with sound. The loading queue below is unchanged: a tap seeks, it does not call load() again.

/** How many loop downloads may run at once. More than this and they fight for the connection. */
const MAX_LOADING = 2

/** Heroes the visitor is watching with sound, so a click on the picture does not jump back to the start. */
const sounding = new WeakSet()

/** Previews the play observer currently has on screen. */
const onScreen = new WeakSet()

const heroBound = new WeakSet()
const previewBound = new WeakSet()
const narrationErrorBound = new WeakSet()

/** Source elements lifted off a hero so load() can paint the poster without fetching the file again. */
const parkedSources = new WeakMap()

/** The video currently playing with sound, one per document. Queue and observer play() wait for it. */
const narrating = new WeakMap()

function narrationBlocks(video) {
    const doc = video?.ownerDocument
    if (!doc) return false
    const current = narrating.get(doc)
    return !!current && current !== video
}

function beginNarration(video) {
    const doc = video?.ownerDocument
    if (doc) narrating.set(doc, video)
}

function endNarration(video) {
    const doc = video?.ownerDocument
    if (doc && narrating.get(doc) === video) narrating.delete(doc)
}

/**
 * A media error after play() resolved never fires ended, so the button would stay hidden and
 * previews would stay blocked. Only the video that is still narrating settles. A stale error
 * from a video that another narration already replaced does nothing.
 */
function bindNarrationError(video) {
    if (!video || narrationErrorBound.has(video) || typeof video.addEventListener !== 'function') return
    narrationErrorBound.add(video)
    video.addEventListener('error', () => {
        const doc = video.ownerDocument
        if (!doc || narrating.get(doc) !== video) return
        settleNarration(video, doc.defaultView)
    })
}

/** Narrow screens, navigator.connection.saveData and reduced motion get the poster and play only when tapped. */
export function canAutoplay(win = window) {
    if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    if (win.matchMedia('(max-width: 50rem)').matches) return false
    // The static host cannot see a Save-Data request header. This is the browser flag.
    return !win.navigator?.connection?.saveData
}

/**
 * Downloads start about a viewport before a loop is played, two at a time.
 * In Chromium, preload="auto" opens a request, and load() does too. load() runs only when the
 * element is still NETWORK_EMPTY, and a second load() would abort playback and set currentTime
 * back to 0. The two-download cap still holds: a slot is taken before preload is set to auto.
 * play() waits until this slot has started the element. A loop that is half on screen
 * moves ahead of the ones that are only nearby, and plays when its download starts.
 *
 * A slot is freed only when:
 * - canplaythrough fires
 * - the video fires error
 * - a source error fires and networkState is NETWORK_NO_SOURCE (the last candidate failed)
 * - the element is already NETWORK_NO_SOURCE or HAVE_ENOUGH_DATA when the slot opens
 * A stalled download keeps its slot. A frozen page aborts the fetch without those events.
 * On resume, or a back-forward pageshow, every held loop that is not yet fully buffered is
 * load()ed once, playing or paused. The playhead is put back on loadedmetadata, and again on
 * loadeddata, canplay, and progress once that time is seekable, until the element is actually there.
 * A second freeze before that seek has landed keeps the same saved time and replaces the
 * listeners, instead of reading the playhead load() just set to 0. The same replacement
 * happens when the saved time is 0, so a second metadata listener cannot call play() again.
 * Once that metadata arrives, a restore that started at 0 is finished, and a later freeze reads
 * the playhead as it is. Any seek this code did not start ends the restore and keeps the visitor's time, including
 * a scrub back to the start. It plays again only if it should still be on screen.
 * That restart is what lets the listeners above free the slot. A fully buffered loop is not loaded again.
 * Safari and Firefox do not fire resume. A socket aborted while the page is hidden, and not
 * restored from the back-forward cache, is started again only if resume was already seen
 * while hidden and the page later becomes visible. Coming back to a visible tab does not
 * restart downloads by itself, because that would abort a download that is still healthy.
 */
function watchLoops(videos, win, doc) {
    const wantsPlay = new WeakSet()
    const queued = new WeakSet()
    const started = new WeakSet()
    const holding = new Set()
    const pending = []
    let active = 0
    let pumping = false
    let restartWhenVisible = false

    const sortPending = () => {
        pending.sort((a, b) => {
            const aw = wantsPlay.has(a) ? 0 : 1
            const bw = wantsPlay.has(b) ? 0 : 1
            if (aw !== bw) return aw - bw
            return videos.indexOf(a) - videos.indexOf(b)
        })
    }

    const pump = () => {
        if (pumping) return
        pumping = true
        try {
            while (active < MAX_LOADING && pending.length) {
                const video = pending.shift()
                started.add(video)
                holding.add(video)
                active += 1
                let released = false
                let onSourceError = () => {}
                const done = () => {
                    if (released) return
                    released = true
                    holding.delete(video)
                    video.removeEventListener('canplaythrough', done)
                    video.removeEventListener('error', done)
                    // Source errors do not bubble. The capture listener is what sees them.
                    video.removeEventListener('error', onSourceError, true)
                    active -= 1
                    pump()
                }
                // Earlier candidates fail while networkState is still LOADING (2). Only the last
                // failure leaves NETWORK_NO_SOURCE (3), with no error event on the video itself.
                onSourceError = () => {
                    if (video.networkState === 3) done()
                }
                video.addEventListener('canplaythrough', done)
                video.addEventListener('error', done)
                video.addEventListener('error', onSourceError, true)
                const readyState = video.readyState || 0
                const networkState = video.networkState || 0
                if (networkState === 3 || readyState >= 4) done()
                else {
                    // Chromium opens the request here. load() is only for an element that has not selected one.
                    video.preload = 'auto'
                    if ((video.readyState || 0) === 0 && (video.networkState || 0) === 0) video.load()
                }
                // A narration holds play() only. The download still takes the slot.
                if (wantsPlay.has(video) && video.networkState !== 3 && !narrationBlocks(video)) video.play().catch(() => {})
            }
        } finally {
            pumping = false
        }
    }

    const enqueue = (video) => {
        if (queued.has(video) || started.has(video)) return
        queued.add(video)
        pending.push(video)
    }

    const playObserver = new win.IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const video = entry.target
                if (entry.isIntersecting) {
                    wantsPlay.add(video)
                    onScreen.add(video)
                    // Already downloading or ready: play does not open another fetch.
                    // Held while a narration is running, so the preview does not move behind it.
                    if (started.has(video)) {
                        if (!narrationBlocks(video)) video.play().catch(() => {})
                    } else enqueue(video)
                } else {
                    wantsPlay.delete(video)
                    onScreen.delete(video)
                    const doc = video.ownerDocument
                    const endedNarration = !!(doc && narrating.get(doc) === video)
                    try {
                        video.pause()
                    } catch {
                        // Already idle.
                    }
                    // Scrolling the sounding video away never fires ended, so the hold would stay forever.
                    // Coming back plays the silent preview, not the narration.
                    if (endedNarration) {
                        endNarration(video)
                        if (sounding.has(video)) leaveSoundMode(video)
                        resumeMutedPreviews(doc, win)
                    }
                }
            }
            sortPending()
            pump()
        },
        { threshold: 0.5 }
    )

    // One viewport above and below. Percentages are of the viewport, not the video.
    const nearObserver = new win.IntersectionObserver(
        (entries) => {
            const entering = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target)
            entering.sort((a, b) => videos.indexOf(a) - videos.indexOf(b))
            for (const video of entering) enqueue(video)
            sortPending()
            pump()
        },
        { rootMargin: '100% 0px', threshold: 0 }
    )

    for (const video of videos) {
        playObserver.observe(video)
        nearObserver.observe(video)
    }

    // Freeze aborts the socket and leaves networkState LOADING, with no error and no emptied.
    // load() runs the resource selection again so the listeners above can free the slot.
    // Chromium ignores currentTime set in loadedmetadata and keeps reporting 0, so the same
    // time is applied again as soon as the seekable range covers it. One restore is in flight
    // per video: a second resume detaches those listeners and keeps the saved time, because
    // load() has already forced currentTime back to 0 and play() may have moved on from there.
    const PLAYHEAD_TOLERANCE = 0.05
    const restores = new WeakMap()
    const documentVisible = () => (doc.visibilityState ? doc.visibilityState === 'visible' : doc.hidden !== true)
    const restartHeld = () => {
        for (const video of [...holding]) {
            const readyState = video.readyState || 0
            if (readyState >= 4 || video.networkState !== 2) continue
            const previous = restores.get(video)
            const saved = previous ? previous.saved : video.currentTime || 0
            if (previous) previous.stop()
            let settled = false
            let assigning = false
            const entry = { saved }
            const nearSaved = (value) => Math.abs((value || 0) - saved) <= PLAYHEAD_TOLERANCE
            const detach = () => {
                video.removeEventListener('loadedmetadata', onMeta)
                video.removeEventListener('loadeddata', onBuffered)
                video.removeEventListener('canplay', onBuffered)
                video.removeEventListener('progress', onBuffered)
                video.removeEventListener('seeking', onSeeking)
            }
            const stop = () => {
                if (settled) return
                settled = true
                detach()
                if (restores.get(video) === entry) restores.delete(video)
            }
            entry.stop = stop
            const seekableCovers = () => {
                const range = video.seekable
                return !!range && range.length > 0 && range.end(0) >= saved
            }
            const assign = () => {
                if (!seekableCovers() || settled) return
                // Stay set until the seeking event. Clearing it in finally runs before Chrome fires seeking.
                assigning = true
                try {
                    video.currentTime = saved
                } catch (error) {
                    assigning = false
                    throw error
                }
                if (assigning && !video.seeking && nearSaved(video.currentTime)) {
                    assigning = false
                    stop()
                }
            }
            // Any seek this code did not start ends the restore, including a scrub back to 0.
            // load() does not fire seeking, so this is the visitor.
            const onSeeking = () => {
                if (settled) return
                if (assigning) {
                    assigning = false
                    if (nearSaved(video.currentTime)) stop()
                    return
                }
                stop()
            }
            const onMeta = () => {
                video.removeEventListener('loadedmetadata', onMeta)
                if (!settled) {
                    if (video.seeking && !nearSaved(video.currentTime)) stop()
                    else if (saved > 0 && seekableCovers()) assign()
                    // A reload that started at 0 has nothing to put back. Drop it once metadata
                    // arrives, unless a visitor seek already ended the restore, so the next freeze
                    // reads the live playhead instead of seeking back to 0.
                    else if (!(saved > 0)) stop()
                }
                if (wantsPlay.has(video) && !narrationBlocks(video)) video.play().catch(() => {})
            }
            const onBuffered = () => {
                if (settled || !(saved > 0)) return
                // canplay can arrive while a scrub is in progress and currentTime is still 0.
                if (video.seeking && !nearSaved(video.currentTime)) {
                    stop()
                    return
                }
                if (nearSaved(video.currentTime)) {
                    stop()
                    return
                }
                if (seekableCovers()) assign()
            }
            // Register a time of 0 too, so the next reload detaches this loadedmetadata listener.
            restores.set(video, entry)
            if (saved > 0) {
                video.addEventListener('loadeddata', onBuffered)
                video.addEventListener('canplay', onBuffered)
                video.addEventListener('progress', onBuffered)
                video.addEventListener('seeking', onSeeking)
            }
            video.addEventListener('loadedmetadata', onMeta)
            video.load()
        }
    }
    // resume and a persisted pageshow can fire in the same turn. One microtask covers both.
    let restartScheduled = false
    const scheduleRestart = () => {
        if (restartScheduled) return
        restartScheduled = true
        queueMicrotask(() => {
            restartScheduled = false
            if (!documentVisible()) {
                restartWhenVisible = true
                return
            }
            restartWhenVisible = false
            restartHeld()
        })
    }
    doc.addEventListener('resume', scheduleRestart)
    doc.addEventListener('visibilitychange', () => {
        if (restartWhenVisible && documentVisible()) scheduleRestart()
    })
    // pageshow is a window event. persisted is the back-forward cache restore.
    win.addEventListener('pageshow', (event) => {
        if (event?.persisted) scheduleRestart()
    })
}

function nextPlayButton(video) {
    let sibling = video?.nextElementSibling
    while (sibling) {
        if (sibling.dataset && 'playWithSound' in sibling.dataset) return sibling
        if (sibling.dataset && ('demoVideo' in sibling.dataset || 'loopVideo' in sibling.dataset)) return null
        sibling = sibling.nextElementSibling
    }
    return null
}

function previousLoop(node) {
    let sibling = node?.previousElementSibling
    while (sibling) {
        if (sibling.dataset && 'loopVideo' in sibling.dataset) return sibling
        sibling = sibling.previousElementSibling
    }
    return null
}

function parkSources(video) {
    if (parkedSources.has(video) || typeof video.querySelectorAll !== 'function') return false
    const sources = [...video.querySelectorAll('source')]
    if (!sources.length) return false
    parkedSources.set(video, sources)
    for (const source of sources) source.remove()
    return true
}

function restoreSources(video) {
    const sources = parkedSources.get(video)
    if (!sources?.length) return
    for (const source of sources) video.appendChild(source)
    parkedSources.delete(video)
}

/** The silent preview: button back, muted, looping, no native controls. Muting does not change volume. */
function leaveSoundMode(video) {
    sounding.delete(video)
    const button = nextPlayButton(video)
    if (button) button.hidden = false
    video.defaultMuted = true
    video.muted = true
    video.loop = true
    video.controls = false
}

/**
 * Seek to the start, then play with sound. load() is not used on this element: it would abort the preview
 * download and drop bytes that are already buffered. Other videos are only paused, so a dialog does not
 * talk over them and the download queue keeps its slots. A hero that was playing with sound leaves that
 * mode first, or the close path cannot resume its silent preview. Volume is left alone: muting does not
 * change it, and a level the visitor set on the controls must survive the next play. Pausing first matters
 * once the preview has moved, because a play() issued while the element is still playing can keep the old position.
 */
function playFromStart(video) {
    // A refused hero parks its sources. They have to be back before play(), including a replay.
    // A dialog is not parked, so this leaves that file attached for the next open.
    restoreSources(video)
    bindNarrationError(video)
    const doc = video.ownerDocument
    if (doc && typeof doc.querySelectorAll === 'function') {
        for (const other of doc.querySelectorAll('video')) {
            if (other === video) continue
            if (sounding.has(other)) leaveSoundMode(other)
            try {
                other.pause()
            } catch {
                // Already idle.
            }
        }
    }
    beginNarration(video)
    video.loop = false
    video.defaultMuted = false
    video.muted = false
    video.controls = true
    let time = 0
    try {
        time = video.currentTime || 0
    } catch {
        time = 0
    }
    if (time > 0.05) {
        try {
            video.pause()
        } catch {
            // Already idle.
        }
    }
    try {
        video.currentTime = 0
    } catch {
        // HAVE_NOTHING cannot seek. Nothing has played, so playback still starts at the beginning.
    }
    const pending = video.play?.()
    if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {
            const doc = video.ownerDocument
            // pause() rejects the play that this narration already replaced. That catch must not
            // resume previews behind the video that is narrating now.
            if (doc && narrating.get(doc) !== video) return
            settleNarration(video, doc?.defaultView)
        })
    }
    return pending
}

/**
 * End a sound session. With autoplay off, the in-place hero drops its sources and loads the empty
 * element so the poster paints. A dialog keeps its sources: prefetch will not call load() again,
 * and parking them would make every later open play an empty element. Otherwise return to the
 * silent preview and resume loops the queue has already started.
 */
function settleNarration(video, win) {
    endNarration(video)
    try {
        video.pause()
    } catch {
        // Already idle.
    }
    if (sounding.has(video)) leaveSoundMode(video)
    const view = win || video.ownerDocument?.defaultView
    const hero = 'demoVideo' in (video.dataset ?? {})
    if (view && !canAutoplay(view) && hero && parkSources(video)) {
        video.load()
        return
    }
    try {
        video.currentTime = 0
    } catch {
        // Leave the playhead. The button still returns.
    }
    resumeMutedPreviews(video.ownerDocument, view)
}

function bindHeroPlay(video, win) {
    if (!video?.dataset || !('demoVideo' in video.dataset) || heroBound.has(video)) return
    const button = nextPlayButton(video)
    if (!button) return
    heroBound.add(video)
    // The silent preview keeps the button. Native controls come back with the sound.
    video.controls = false
    const start = () => {
        sounding.add(video)
        button.hidden = true
        // Sources come back before play(). load() while they are attached would fetch the file twice.
        restoreSources(video)
        playFromStart(video)
    }
    button.addEventListener('click', start)
    video.addEventListener('click', () => {
        if (sounding.has(video)) return
        start()
    })
    video.addEventListener('ended', () => {
        if (!sounding.has(video)) return
        // Seeking to 0 paints frame 0. On this file that frame is empty, so with autoplay off the
        // poster is loaded only after the sources are detached.
        settleNarration(video, win)
    })
}

function resumeMutedPreviews(doc, win) {
    const view = win || doc?.defaultView
    if (!view || !canAutoplay(view) || typeof doc?.querySelectorAll !== 'function') return
    if (narrating.has(doc)) return
    for (const preview of doc.querySelectorAll('[data-demo-video], [data-loop-video]')) {
        if (!preview?.dataset || sounding.has(preview) || parkedSources.has(preview) || !onScreen.has(preview)) continue
        preview.defaultMuted = true
        preview.muted = true
        preview.loop = true
        // play() on a preload="none" element that has not started opens a fetch outside the two-at-a-time queue.
        // wantsPlay is still set, so the pump plays it when a slot opens.
        if (preview.preload !== 'auto' && !(preview.readyState > 0)) continue
        const pending = preview.play?.()
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    }
}

/**
 * Ends a hero narration when that video leaves the screen. Installed whether or not previews
 * autoplay. It does not enqueue a download or call load(): coming back does not resume the sound.
 */
function watchNarrationScroll(videos, win) {
    if (!('IntersectionObserver' in win)) return
    const heroes = videos.filter((video) => 'demoVideo' in (video.dataset ?? {}))
    if (!heroes.length) return
    const observer = new win.IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) continue
                const video = entry.target
                const owner = video.ownerDocument
                if (!owner || narrating.get(owner) !== video) continue
                try {
                    video.pause()
                } catch {
                    // Already idle.
                }
                // ended never fires when the hero scrolls away, so the sound session would stay open.
                endNarration(video)
                if (sounding.has(video)) leaveSoundMode(video)
                resumeMutedPreviews(owner, win)
            }
        },
        { threshold: 0.5 }
    )
    for (const video of heroes) observer.observe(video)
}

/** Plays the demo video and the tile loops while they are on screen, when autoplay is fine for this visitor. */
export function initDemoVideo(doc = document, win = window) {
    const videos = [...doc.querySelectorAll('[data-demo-video], [data-loop-video]')]
    for (const video of videos) {
        bindHeroPlay(video, win)
        bindNarrationError(video)
    }
    if (!videos.length || !('IntersectionObserver' in win) || !canAutoplay(win)) {
        // Nothing starts on its own, so a tap on the narrated demo should play it with its sound.
        for (const video of videos) if ('demoVideo' in (video.dataset ?? {})) video.muted = false
        // A tap can still start the hero. Scrolling it away has to end that narration.
        watchNarrationScroll(videos, win)
        return false
    }
    watchLoops(videos, win, doc)
    watchNarrationScroll(videos, win)
    return true
}

/** Fetch the dialog video once. Do not play it: the narrated file has sound, and only the click should start it. */
function prefetchDialog(video, started) {
    if (started.has(video)) return
    started.add(video)
    video.preload = 'auto'
    video.load()
}

/** The "Watch with sound" links open the narrated video in a dialog. Without the script they open the file. */
export function initVideoDialogs(doc = document) {
    const started = new WeakSet()
    let count = 0
    for (const link of doc.querySelectorAll('[data-video-dialog-open]')) {
        const dialog = doc.getElementById(link.dataset.videoDialogOpen)
        const video = dialog?.querySelector('video')
        if (!video || typeof dialog.showModal !== 'function') continue
        count++
        bindNarrationError(video)
        const open = (event) => {
            event?.preventDefault?.()
            dialog.showModal()
            // Every open starts at the beginning. Closing only pauses, so the next open has to seek.
            const pending = playFromStart(video)
            // playFromStart already ends the narration if this play is rejected. Pause the dialog video too.
            if (pending && typeof pending.then === 'function') {
                pending.catch(() => {
                    try {
                        video.pause()
                    } catch {
                        // Already idle.
                    }
                })
            }
        }
        link.addEventListener('click', open)
        const preview = previousLoop(link)
        if (preview && !previewBound.has(preview)) {
            previewBound.add(preview)
            preview.addEventListener('click', open)
        }
        dialog.addEventListener('close', () => {
            endNarration(video)
            try {
                video.pause()
            } catch {
                // Already idle.
            }
            // The open paused every other video. On-screen silent loops start again when autoplay is allowed.
            resumeMutedPreviews(doc)
        })
        // A click on the backdrop lands on the dialog itself.
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close()
        })
        const warm = () => prefetchDialog(video, started)
        link.addEventListener('pointerenter', warm)
        link.addEventListener('focus', warm)
        link.addEventListener('pointerdown', warm)
    }
    return count
}
