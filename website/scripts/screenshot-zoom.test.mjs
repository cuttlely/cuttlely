import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    clampPan,
    enlargeLabel,
    fitScale,
    largestSrc,
    shouldZoomImage,
    wrapZoomableImages,
    zoomAtPoint,
    zoomedScale
} from '../src/scripts/screenshot-zoom.mjs'

const shot = '<img src="/a.png" alt="A harness canvas" width="1440" height="900" srcset="/a-sm.png 480w, /a-lg.png 1440w">'

describe('screenshot zoom rules', () => {
    it('builds the control name from the alt text', () => {
        assert.equal(enlargeLabel('A harness canvas'), 'Enlarge screenshot: A harness canvas')
    })

    it('skips decorative images and keeps screenshots', () => {
        assert.equal(shouldZoomImage({ alt: 'A harness canvas', src: '/a.png', width: '1440' }), true)
        assert.equal(shouldZoomImage({ alt: '', src: '/mascot.webp' }), false)
        assert.equal(shouldZoomImage({ alt: 'Cuttlely', src: '/logo.svg' }), false)
        assert.equal(shouldZoomImage({ alt: 'Mascot', src: '/m.webp', className: 'cl-final-mascot' }), false)
        assert.equal(shouldZoomImage({ alt: 'Icon', src: '/i.png', width: '28' }), false)
    })

    it('picks the largest srcset candidate', () => {
        assert.equal(largestSrc('/a.png', '/a-sm.png 480w, /a-lg.png 1440w'), '/a-lg.png')
        assert.equal(largestSrc('/a.png', '/a.png 1x, /a@2.png 2x'), '/a@2.png')
        assert.equal(largestSrc('/a.png', ''), '/a.png')
    })
})

describe('screenshot zoom math', () => {
    it('fits without enlarging, and the other stop is 100% or 2x', () => {
        const fit = fitScale(800, 600, 1600, 1000)
        assert.ok(fit < 1)
        assert.equal(zoomedScale(fit), 1)
        assert.equal(fitScale(2000, 1200, 800, 500), 1)
        assert.equal(zoomedScale(1), 2)
    })

    it('keeps the image point under the pointer when zooming', () => {
        const before = { scale: 0.5, tx: 10, ty: -4, viewW: 800, viewH: 600, min: 0.25, max: 4 }
        const pointer = { x: 500, y: 200 }
        const imageX = (pointer.x - before.viewW / 2 - before.tx) / before.scale
        const imageY = (pointer.y - before.viewH / 2 - before.ty) / before.scale
        const after = zoomAtPoint(before, pointer.x, pointer.y, 1)
        const nextX = (pointer.x - before.viewW / 2 - after.tx) / after.scale
        const nextY = (pointer.y - before.viewH / 2 - after.ty) / after.scale
        assert.ok(Math.abs(imageX - nextX) < 1e-9)
        assert.ok(Math.abs(imageY - nextY) < 1e-9)
        assert.equal(after.scale, 1)
    })

    it('clamps pan so the image cannot leave the viewport', () => {
        const pan = clampPan({ tx: 5000, ty: -5000, scale: 1, viewW: 800, viewH: 600, imgW: 1000, imgH: 700 })
        assert.equal(pan.tx, 100)
        assert.equal(pan.ty, -50)
        const locked = clampPan({ tx: 40, ty: 40, scale: 0.5, viewW: 800, viewH: 600, imgW: 1000, imgH: 700 })
        assert.deepEqual(locked, { tx: 0, ty: 0 })
    })
})

describe('wrapZoomableImages', () => {
    it('wraps a docs screenshot in a link to the full file and leaves the rest of the page', () => {
        const html = `<header><img src="/logo.svg" alt="Cuttlely"></header><div class="cl-page" data-screenshot-zoom><p>${shot}</p></div>`
        const out = wrapZoomableImages(html)
        assert.match(out, /<header><img src="\/logo.svg" alt="Cuttlely"><\/header>/)
        assert.match(
            out,
            /<a class="cl-zoom" href="\/a-lg.png" role="button" draggable="false" aria-label="Enlarge screenshot: A harness canvas">/
        )
        assert.equal(wrapZoomableImages(out), out)
    })

    it('skips mascots, empty alt, existing links, not-content and script text', () => {
        const html = [
            '<div data-screenshot-zoom>',
            '<img src="/m.webp" alt="" class="cl-final-mascot">',
            '<div class="not-content"><img src="/shot.png" alt="Already framed" width="800"></div>',
            '<a href="/docs/"><img src="/shot.png" alt="Linked shot" width="800"></a>',
            '<script>const html = \'<img src="/nope.png" alt="Not real" width="800">\'</script>',
            shot,
            '</div>'
        ].join('')
        const out = wrapZoomableImages(html)
        assert.equal(out.match(/class="cl-zoom"/g).length, 1)
        assert.match(out, /href="\/a-lg.png"/)
        assert.match(out, /<script>const html = '<img src="\/nope.png" alt="Not real" width="800">'<\/script>/)
    })

    it('escapes alt text in the control name', () => {
        const html = '<div data-screenshot-zoom><img src="/a.png" alt="Tom &amp; &quot;Jerry&quot;" width="400"></div>'
        const out = wrapZoomableImages(html)
        assert.match(out, /aria-label="Enlarge screenshot: Tom &amp; &quot;Jerry&quot;"/)
    })
})
