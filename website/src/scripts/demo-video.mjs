// Home page videos. First paint is the poster only: sources stay detached and nothing autoplays
// until the visitor clicks play. Product-tile silent loops start only after that click, one at a
// time, and never when Save-Data is on. Loaded from the footer as a same-origin module.

/** Heroes the visitor is watching with sound, so a click on the picture does not jump back to the start. */
const sounding = new WeakSet()

/** Previews the play observer currently has on screen. */
const onScreen = new WeakSet()

const heroBound = new WeakSet()
const previewBound = new WeakSet()
const narrationErrorBound = new WeakSet()
const loopWatchBound = new WeakSet()

/** Source elements lifted off a video so load() can paint the poster without fetching the file. */
const parkedSources = new WeakMap()

/** The video currently playing with sound, one per document. */
const narrating = new WeakMap()

/** The muted tile loop currently playing, one per document. */
const looping = new WeakMap()

/** Documents where the visitor has clicked play, so a muted loop may start. */
const loopUnlocked = new WeakSet()

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

function unlockLoops(video) {
    const doc = video?.ownerDocument
    if (doc) loopUnlocked.add(doc)
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

function saveDataOn(win = window) {
    return !!win.navigator?.connection?.saveData
}

/** Muted tile loops after a play click. Same opt-outs as autoplay, plus Save-Data on its own. */
function canLoopPreviews(win = window) {
    return canAutoplay(win) && !saveDataOn(win)
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

function parkAllVideos(doc) {
    if (typeof doc?.querySelectorAll !== 'function') return
    for (const video of doc.querySelectorAll('video')) parkSources(video)
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

function pauseLoop(video) {
    const doc = video?.ownerDocument
    if (doc && looping.get(doc) === video) looping.delete(doc)
    try {
        video.pause()
    } catch {
        // Already idle.
    }
}

function stopMutedLoop(video) {
    if (!video) return
    pauseLoop(video)
    if (parkSources(video)) {
        try {
            video.load()
        } catch {
            // Empty element.
        }
    }
}

function startMutedLoop(video, win) {
    if (!video || !('loopVideo' in (video.dataset ?? {}))) return
    if (!canLoopPreviews(win) || saveDataOn(win) || narrationBlocks(video)) return
    const doc = video.ownerDocument
    if (!doc || !loopUnlocked.has(doc)) return
    const current = looping.get(doc)
    if (current && current !== video) stopMutedLoop(current)
    const wasParked = parkedSources.has(video)
    restoreSources(video)
    video.preload = 'auto'
    if (wasParked && (video.readyState || 0) === 0) {
        try {
            video.load()
        } catch {
            // Empty element or a test double.
        }
    }
    video.defaultMuted = true
    video.muted = true
    video.loop = true
    video.controls = false
    looping.set(doc, video)
    const pending = video.play?.()
    if (pending && typeof pending.catch === 'function') pending.catch(() => {})
}

function playActiveLoop(doc, win) {
    const view = win || doc?.defaultView
    if (!view || !doc || !loopUnlocked.has(doc) || !canLoopPreviews(view) || narrating.has(doc)) return
    if (typeof doc.querySelectorAll !== 'function') return
    const current = looping.get(doc)
    if (current && onScreen.has(current)) {
        startMutedLoop(current, view)
        return
    }
    const next = [...doc.querySelectorAll('[data-loop-video]')].find((video) => onScreen.has(video) && 'loopVideo' in (video.dataset ?? {}))
    if (next) startMutedLoop(next, view)
}

/**
 * Seek to the start, then play with sound. Other videos are only paused, so a dialog does not
 * talk over them. A hero that was playing with sound leaves that mode first. Volume is left
 * alone: muting does not change it, and a level the visitor set on the controls must survive
 * the next play.
 */
function playFromStart(video) {
    const wasParked = parkedSources.has(video)
    restoreSources(video)
    if (wasParked) {
        video.preload = 'auto'
        try {
            video.load()
        } catch {
            // Empty element or a test double.
        }
    }
    bindNarrationError(video)
    unlockLoops(video)
    const doc = video.ownerDocument
    if (doc && typeof doc.querySelectorAll === 'function') {
        for (const other of doc.querySelectorAll('video')) {
            if (other === video) continue
            if (sounding.has(other)) leaveSoundMode(other)
            if (looping.get(doc) === other) pauseLoop(other)
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
            const owner = video.ownerDocument
            // pause() rejects the play that this narration already replaced. That catch must not
            // resume previews behind the video that is narrating now.
            if (owner && narrating.get(owner) !== video) return
            settleNarration(video, owner?.defaultView)
        })
    }
    return pending
}

/**
 * End a sound session. The in-place hero drops its sources and loads the empty element so the
 * poster paints. A dialog keeps its sources: parking them would make every later open play an
 * empty element. Tile loops resume one at a time after this, when the visitor has already
 * clicked play and Save-Data is off.
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
    if (hero && parkSources(video)) {
        try {
            video.load()
        } catch {
            // Empty element.
        }
        playActiveLoop(video.ownerDocument, view)
        return
    }
    try {
        video.currentTime = 0
    } catch {
        // Leave the playhead. The button still returns.
    }
    playActiveLoop(video.ownerDocument, view)
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
        playFromStart(video)
    }
    button.addEventListener('click', start)
    video.addEventListener('click', () => {
        if (sounding.has(video)) return
        start()
    })
    video.addEventListener('ended', () => {
        if (!sounding.has(video)) return
        settleNarration(video, win)
    })
}

/**
 * Tracks which videos are on screen. A hero that leaves while narrating ends that session.
 * After a play click, one muted tile loop may run for an on-screen tile. Sources stay
 * detached until that loop is chosen.
 */
function watchViewport(videos, win, doc) {
    if (!videos.length || !('IntersectionObserver' in win) || loopWatchBound.has(doc)) return
    loopWatchBound.add(doc)
    const observer = new win.IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const video = entry.target
                const owner = video.ownerDocument
                if (entry.isIntersecting) onScreen.add(video)
                else {
                    onScreen.delete(video)
                    if (owner && looping.get(owner) === video) {
                        try {
                            video.pause()
                        } catch {
                            // Already idle.
                        }
                    }
                    if (!owner || narrating.get(owner) !== video) continue
                    settleNarration(video, win)
                }
            }
            playActiveLoop(doc, win)
        },
        { threshold: 0.5 }
    )
    for (const video of videos) observer.observe(video)
}

/**
 * Parks every source on first paint. Heroes play only when the visitor clicks play.
 * Tile loops may start later, one at a time, after that click, when canAutoplay is true.
 */
export function initDemoVideo(doc = document, win = window) {
    parkAllVideos(doc)
    const videos = [...doc.querySelectorAll('[data-demo-video], [data-loop-video]')]
    for (const video of videos) {
        bindHeroPlay(video, win)
        bindNarrationError(video)
        // A tap on the narrated demo should play it with its sound. Loops stay muted.
        if ('demoVideo' in (video.dataset ?? {})) video.muted = false
    }
    watchViewport(videos, win, doc)
    return false
}

/** The "Watch with sound" links open the narrated video in a dialog. Without the script they open the file. */
export function initVideoDialogs(doc = document) {
    parkAllVideos(doc)
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
            playActiveLoop(doc, doc.defaultView)
        })
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close()
        })
    }
    return count
}
