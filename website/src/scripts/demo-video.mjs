// The home page videos: the narrated demo and the short loops on the product tiles. Loaded from the footer script, a
// same-origin module, so the site CSP needs no new hash. The controls always work.

/** Small screens, Save-Data and reduced motion get the poster and play only when tapped. */
export function canAutoplay(win = window) {
    if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    if (win.matchMedia('(max-width: 50rem)').matches) return false
    return !win.navigator?.connection?.saveData
}

function playWhileOnScreen(videos, win) {
    const observer = new win.IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) entry.target.play().catch(() => {})
                else entry.target.pause()
            }
        },
        { threshold: 0.5 }
    )
    for (const video of videos) observer.observe(video)
}

/** Plays the demo video and the tile loops while they are on screen, when autoplay is fine for this visitor. */
export function initDemoVideo(doc = document, win = window) {
    const videos = [...doc.querySelectorAll('[data-demo-video], [data-loop-video]')]
    if (!videos.length || !('IntersectionObserver' in win) || !canAutoplay(win)) {
        // Nothing starts on its own, so a tap on the narrated demo should play it with its sound.
        for (const video of videos) if ('demoVideo' in (video.dataset ?? {})) video.muted = false
        return false
    }
    playWhileOnScreen(videos, win)
    return true
}

/** The "Watch with sound" links open the narrated video in a dialog. Without the script they open the file. */
export function initVideoDialogs(doc = document) {
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
    }
    return count
}
