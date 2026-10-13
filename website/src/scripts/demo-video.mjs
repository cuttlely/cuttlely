// The home page videos: the narrated demo and the short loops on the product tiles. Loaded from the footer script, a
// same-origin module, so the site CSP needs no new hash. The controls always work.

/** How many loop downloads may run at once. More than this and they fight for the connection. */
const MAX_LOADING = 2

/** Narrow screens, navigator.connection.saveData and reduced motion get the poster and play only when tapped. */
export function canAutoplay(win = window) {
    if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    if (win.matchMedia('(max-width: 50rem)').matches) return false
    // The static host cannot see a Save-Data request header. This is the browser flag.
    return !win.navigator?.connection?.saveData
}

/**
 * Downloads start about a viewport before a loop is played, two at a time.
 * In Chromium, setting preload="auto" is what opens the request. load() runs only when the
 * element is still NETWORK_EMPTY, and a second load() would abort playback and set currentTime
 * back to 0. play() waits until this slot has started the element. A loop that is half on screen
 * moves ahead of the ones that are only nearby, and plays when its download starts.
 */
function watchLoops(videos, win) {
    const wantsPlay = new WeakSet()
    const queued = new WeakSet()
    const started = new WeakSet()
    const pending = []
    let active = 0
    let pumping = false

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
                active += 1
                let released = false
                let onSourceError = () => {}
                const done = () => {
                    if (released) return
                    released = true
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
                if (wantsPlay.has(video) && video.networkState !== 3) video.play().catch(() => {})
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
                    // Already downloading or ready: play does not open another fetch.
                    if (started.has(video)) video.play().catch(() => {})
                    else enqueue(video)
                } else {
                    wantsPlay.delete(video)
                    video.pause()
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
}

/** Plays the demo video and the tile loops while they are on screen, when autoplay is fine for this visitor. */
export function initDemoVideo(doc = document, win = window) {
    const videos = [...doc.querySelectorAll('[data-demo-video], [data-loop-video]')]
    if (!videos.length || !('IntersectionObserver' in win) || !canAutoplay(win)) {
        // Nothing starts on its own, so a tap on the narrated demo should play it with its sound.
        for (const video of videos) if ('demoVideo' in (video.dataset ?? {})) video.muted = false
        return false
    }
    watchLoops(videos, win)
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
        link.addEventListener('click', (event) => {
            event.preventDefault()
            dialog.showModal()
            video.play().catch(() => {})
        })
        dialog.addEventListener('close', () => video.pause())
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
