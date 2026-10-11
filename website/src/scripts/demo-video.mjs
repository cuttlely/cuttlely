// Plays the home page demo video while it is on screen, unless the visitor asked for reduced motion. The controls
// always work. Loaded from the footer script, a same-origin module, so the site CSP needs no new hash.
export function initDemoVideo(doc = document, win = window) {
    const video = doc.querySelector('[data-demo-video]')
    if (!video || !('IntersectionObserver' in win) || win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    new win.IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) video.play().catch(() => {})
                else video.pause()
            }
        },
        { threshold: 0.5 }
    ).observe(video)
    return true
}
