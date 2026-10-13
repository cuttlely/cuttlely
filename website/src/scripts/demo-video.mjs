// The home page videos: the narrated demo and the short loops on the product tiles. Loaded from the footer script, a
// same-origin module, so the site CSP needs no new hash. The controls always work.

/** How many loop downloads may run at once. More than this and they fight for the connection. */
const MAX_LOADING = 2

/** Small screens, Save-Data and reduced motion get the poster and play only when tapped. */
export function canAutoplay(win = window) {
    if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    if (win.matchMedia('(max-width: 50rem)').matches) return false
    return !win.navigator?.connection?.saveData
}

function markPlay(wantsPlay, video, playing) {
    if (playing) wantsPlay.add(video)
    else wantsPlay.delete(video)
}

/**
 * Downloads start about a viewport before a loop is played, two at a time, in page order.
 * Play and pause stay on the half-visible rule.
 */
function watchLoops(videos, win) {
    const wantsPlay = new WeakSet()
    const queued = new WeakSet()
    const pending = []
    let active = 0
    let pumping = false

    const pump = () => {
        if (pumping) return
        pumping = true
        try {
            while (active < MAX_LOADING && pending.length) {
                const video = pending.shift()
                active += 1
                video.preload = 'auto'
                let released = false
                const done = () => {
                    if (released) return
                    released = true
                    video.removeEventListener('canplaythrough', done)
                    video.removeEventListener('error', done)
                    active -= 1
                    pump()
                }
                video.addEventListener('canplaythrough', done)
                video.addEventListener('error', done)
                video.load()
                // load() resets the element, so a loop that is already on screen has to be asked again.
                if (wantsPlay.has(video)) video.play().catch(() => {})
            }
        } finally {
            pumping = false
        }
    }

    const enqueue = (video) => {
        if (queued.has(video)) return
        queued.add(video)
        const at = videos.indexOf(video)
        let index = 0
        while (index < pending.length && videos.indexOf(pending[index]) < at) index += 1
        pending.splice(index, 0, video)
    }

    const playObserver = new win.IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const video = entry.target
                if (entry.isIntersecting) {
                    markPlay(wantsPlay, video, true)
                    video.play().catch(() => {})
                } else {
                    markPlay(wantsPlay, video, false)
                    video.pause()
                }
            }
        },
        { threshold: 0.5 }
    )

    // One viewport above and below. Percentages are of the viewport, not the video.
    const nearObserver = new win.IntersectionObserver(
        (entries) => {
            const entering = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target)
            entering.sort((a, b) => videos.indexOf(a) - videos.indexOf(b))
            for (const video of entering) enqueue(video)
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
