// Full-screen screenshot viewer. Loaded as a bundled module from the footer
// (script-src 'self'); it does not add an inline script.
import { clampPan, enlargeLabel, fitScale, largestSrc, shouldZoomImage, zoomAtPoint, zoomedScale } from './screenshot-zoom.mjs'

const STATE = 'clShot'
const PAD = 24

let started = false

export function initScreenshotViewer() {
    if (started || typeof document === 'undefined') return
    started = true
    enhanceContentImages(document)
    const ui = createDialog()
    for (const anchor of document.querySelectorAll('a.cl-zoom')) bindTrigger(anchor, ui)
}

/** Dev and any page the build rewrite did not touch: same rules as wrapZoomableImages. */
function enhanceContentImages(doc) {
    for (const region of doc.querySelectorAll('[data-screenshot-zoom]')) {
        for (const img of region.querySelectorAll('img')) {
            if (img.closest('.not-content, a, .cl-zoom')) continue
            const info = {
                alt: img.getAttribute('alt') || '',
                src: img.getAttribute('src') || '',
                className: img.getAttribute('class') || '',
                width: img.getAttribute('width') || ''
            }
            if (!shouldZoomImage(info)) continue
            const anchor = doc.createElement('a')
            anchor.className = 'cl-zoom'
            anchor.href = largestSrc(info.src, img.getAttribute('srcset') || '')
            anchor.setAttribute('role', 'button')
            anchor.setAttribute('draggable', 'false')
            anchor.setAttribute('aria-label', enlargeLabel(info.alt))
            img.replaceWith(anchor)
            anchor.append(img)
        }
    }
}

function bindTrigger(anchor, ui) {
    if (anchor.dataset.clZoomBound) return
    anchor.dataset.clZoomBound = '1'
    anchor.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        openViewer(ui, anchor)
    })
    // A link only activates on Enter. Role is button, so Space opens it too.
    anchor.addEventListener('keydown', (event) => {
        if (event.key !== ' ' && event.code !== 'Space') return
        event.preventDefault()
        openViewer(ui, anchor)
    })
}

function safeSrc(anchor) {
    const raw = anchor.getAttribute('href') || ''
    try {
        const url = new URL(raw, location.href)
        if (url.origin !== location.origin) return ''
        return url.href
    } catch {
        return ''
    }
}

function createDialog() {
    const dialog = document.createElement('dialog')
    dialog.className = 'cl-viewer'
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'cl-viewer-caption')
    dialog.innerHTML = `
        <div class="cl-viewer-stage" data-cl-stage>
            <img class="cl-viewer-img" alt="" draggable="false" />
        </div>
        <p id="cl-viewer-caption" class="cl-viewer-caption"></p>
        <div class="cl-viewer-controls">
            <button type="button" data-cl-zoom="out" aria-label="Zoom out"><span aria-hidden="true">−</span></button>
            <button type="button" data-cl-zoom="in" aria-label="Zoom in"><span aria-hidden="true">+</span></button>
            <button type="button" data-cl-close aria-label="Close"><span aria-hidden="true">×</span></button>
        </div>
    `
    document.body.append(dialog)

    const stage = dialog.querySelector('[data-cl-stage]')
    const img = dialog.querySelector('.cl-viewer-img')
    const caption = dialog.querySelector('.cl-viewer-caption')
    const closeBtn = dialog.querySelector('[data-cl-close]')
    const ui = {
        dialog,
        stage,
        img,
        caption,
        closeBtn,
        pushed: false,
        restore: null,
        scale: 1,
        fit: 1,
        tx: 0,
        ty: 0,
        imgW: 1,
        imgH: 1,
        pointers: new Map(),
        pinch: null,
        drag: null,
        moved: false,
        downOnBackdrop: false,
        lastToggle: 0,
        lastTap: 0,
        lastTapX: 0,
        lastTapY: 0
    }

    dialog.addEventListener('cancel', (event) => {
        event.preventDefault()
        requestClose(ui)
    })
    dialog.addEventListener('close', () => finishClose(ui))
    window.addEventListener('popstate', () => {
        ui.pushed = false
        if (dialog.open) dialog.close()
    })
    // Pointer capture retargets the click to the stage, so backdrop close uses the
    // element that was actually pressed (the empty stage), not the click target.
    dialog.addEventListener(
        'wheel',
        (event) => {
            if (!dialog.open) return
            event.preventDefault()
            let delta = event.deltaY
            if (event.deltaMode === 1) delta *= 16
            else if (event.deltaMode === 2) delta *= 400
            const factor = Math.min(1.25, Math.max(0.8, Math.exp(-delta * 0.002)))
            zoomBy(ui, factor, event.clientX, event.clientY, false)
        },
        { passive: false }
    )
    dialog.addEventListener('keydown', (event) => onKey(ui, event))
    closeBtn.addEventListener('click', () => requestClose(ui))
    dialog.querySelector('[data-cl-zoom="in"]').addEventListener('click', () => zoomBy(ui, 1.25, null, null, true))
    dialog.querySelector('[data-cl-zoom="out"]').addEventListener('click', () => zoomBy(ui, 1 / 1.25, null, null, true))
    stage.addEventListener('dblclick', (event) => {
        event.preventDefault()
        toggleZoom(ui, event.clientX, event.clientY)
    })
    stage.addEventListener('pointerdown', (event) => onPointerDown(ui, event))
    stage.addEventListener('pointermove', (event) => onPointerMove(ui, event))
    stage.addEventListener('pointerup', (event) => onPointerUp(ui, event))
    stage.addEventListener('pointercancel', (event) => onPointerUp(ui, event))
    window.addEventListener('resize', () => {
        if (dialog.open) layout(ui)
    })
    return ui
}

function openViewer(ui, anchor) {
    const src = safeSrc(anchor)
    if (!src) return
    const shot = anchor.querySelector('img')
    const alt = shot?.getAttribute('alt') || ''
    ui.restore = anchor
    ui.caption.textContent = alt
    ui.dialog.showModal()
    document.documentElement.classList.add('cl-viewer-open')
    ui.closeBtn.focus()
    if (!ui.pushed) {
        history.pushState({ [STATE]: 1 }, '')
        ui.pushed = true
    }
    const show = () => {
        ui.imgW = ui.img.naturalWidth || 1
        ui.imgH = ui.img.naturalHeight || 1
        ui.img.style.width = `${ui.imgW}px`
        ui.img.style.height = `${ui.imgH}px`
        ui.fit = currentFit(ui)
        ui.scale = ui.fit
        ui.tx = 0
        ui.ty = 0
        paint(ui, false)
    }
    if (ui.img.getAttribute('src') !== src) {
        ui.img.onload = () => show()
        ui.img.src = src
    }
    if (ui.img.complete && ui.img.naturalWidth && ui.img.src === src) show()
}

function requestClose(ui) {
    if (!ui.dialog.open) return
    if (ui.pushed) {
        ui.pushed = false
        history.back()
        return
    }
    ui.dialog.close()
}

function finishClose(ui) {
    document.documentElement.classList.remove('cl-viewer-open')
    ui.pointers.clear()
    ui.pinch = null
    ui.drag = null
    const back = ui.restore
    ui.restore = null
    if (back && document.contains(back)) back.focus()
}

function viewBox(ui) {
    const rect = ui.stage.getBoundingClientRect()
    return { viewW: rect.width, viewH: rect.height, left: rect.left, top: rect.top }
}

function currentFit(ui) {
    const { viewW, viewH } = viewBox(ui)
    return fitScale(viewW, viewH, ui.imgW, ui.imgH, PAD)
}

function limits(ui) {
    return { min: ui.fit, max: Math.max(4, zoomedScale(ui.fit) * 2) }
}

function paint(ui, animate) {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ui.img.classList.toggle('is-animating', Boolean(animate) && !reduced)
    ui.img.style.transform = `translate(calc(-50% + ${ui.tx}px), calc(-50% + ${ui.ty}px)) scale(${ui.scale})`
    const zoomed = ui.scale > ui.fit * 1.02
    ui.stage.classList.toggle('is-pannable', zoomed)
    ui.stage.classList.toggle('is-dragging', Boolean(ui.drag))
}

function applyZoom(ui, next, animate) {
    const { viewW, viewH } = viewBox(ui)
    const pan = clampPan({ ...next, viewW, viewH, imgW: ui.imgW, imgH: ui.imgH })
    ui.scale = next.scale
    ui.tx = pan.tx
    ui.ty = pan.ty
    paint(ui, animate)
}

function zoomBy(ui, factor, clientX, clientY, animate) {
    const box = viewBox(ui)
    const { min, max } = limits(ui)
    const pointerX = clientX == null ? box.viewW / 2 : clientX - box.left
    const pointerY = clientY == null ? box.viewH / 2 : clientY - box.top
    const next = zoomAtPoint(
        { scale: ui.scale, tx: ui.tx, ty: ui.ty, viewW: box.viewW, viewH: box.viewH, min, max },
        pointerX,
        pointerY,
        ui.scale * factor
    )
    applyZoom(ui, next, animate)
}

function toggleZoom(ui, clientX, clientY) {
    const now = performance.now()
    if (now - ui.lastToggle < 400) return
    ui.lastToggle = now
    const box = viewBox(ui)
    const { min, max } = limits(ui)
    const target = zoomedScale(ui.fit)
    const atTarget = Math.abs(ui.scale - target) < 0.02
    if (atTarget) {
        ui.scale = ui.fit
        ui.tx = 0
        ui.ty = 0
        paint(ui, true)
        return
    }
    const next = zoomAtPoint(
        { scale: ui.scale, tx: ui.tx, ty: ui.ty, viewW: box.viewW, viewH: box.viewH, min, max },
        clientX - box.left,
        clientY - box.top,
        target
    )
    applyZoom(ui, next, true)
}

function layout(ui) {
    const wasFit = Math.abs(ui.scale - ui.fit) < 0.02
    ui.fit = currentFit(ui)
    if (wasFit) {
        ui.scale = ui.fit
        ui.tx = 0
        ui.ty = 0
    } else {
        const { min, max } = limits(ui)
        ui.scale = Math.min(max, Math.max(min, ui.scale))
    }
    const box = viewBox(ui)
    const pan = clampPan({ tx: ui.tx, ty: ui.ty, scale: ui.scale, viewW: box.viewW, viewH: box.viewH, imgW: ui.imgW, imgH: ui.imgH })
    ui.tx = pan.tx
    ui.ty = pan.ty
    paint(ui, false)
}

function onKey(ui, event) {
    if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomBy(ui, 1.25, null, null, true)
    } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        zoomBy(ui, 1 / 1.25, null, null, true)
    } else if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        const step =
            event.key === 'ArrowLeft' ? [-48, 0] : event.key === 'ArrowRight' ? [48, 0] : event.key === 'ArrowUp' ? [0, -48] : [0, 48]
        const box = viewBox(ui)
        const pan = clampPan({
            tx: ui.tx + step[0],
            ty: ui.ty + step[1],
            scale: ui.scale,
            viewW: box.viewW,
            viewH: box.viewH,
            imgW: ui.imgW,
            imgH: ui.imgH
        })
        ui.tx = pan.tx
        ui.ty = pan.ty
        paint(ui, true)
    }
}

function onPointerDown(ui, event) {
    if (event.button !== 0) return
    ui.downOnBackdrop = event.target === ui.stage
    ui.stage.setPointerCapture(event.pointerId)
    ui.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    ui.moved = false
    if (ui.pointers.size === 2) {
        ui.drag = null
        ui.pinch = pinchFrom(ui)
        return
    }
    ui.drag = { x: event.clientX, y: event.clientY, tx: ui.tx, ty: ui.ty }
    paint(ui, false)
}

function onPointerMove(ui, event) {
    if (!ui.pointers.has(event.pointerId)) return
    ui.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (ui.pointers.size >= 2 && ui.pinch) {
        const next = pinchFrom(ui)
        const box = viewBox(ui)
        const { min, max } = limits(ui)
        ui.tx += next.midX - ui.pinch.midX
        ui.ty += next.midY - ui.pinch.midY
        const zoomed = zoomAtPoint(
            { scale: ui.scale, tx: ui.tx, ty: ui.ty, viewW: box.viewW, viewH: box.viewH, min, max },
            next.midX - box.left,
            next.midY - box.top,
            ui.pinch.scale * (next.dist / ui.pinch.dist)
        )
        ui.pinch = { ...next, scale: ui.pinch.scale, dist: ui.pinch.dist }
        applyZoom(ui, zoomed, false)
        ui.moved = true
        return
    }
    if (!ui.drag) return
    const dx = event.clientX - ui.drag.x
    const dy = event.clientY - ui.drag.y
    if (Math.hypot(dx, dy) > 4) ui.moved = true
    const box = viewBox(ui)
    const pan = clampPan({
        tx: ui.drag.tx + dx,
        ty: ui.drag.ty + dy,
        scale: ui.scale,
        viewW: box.viewW,
        viewH: box.viewH,
        imgW: ui.imgW,
        imgH: ui.imgH
    })
    ui.tx = pan.tx
    ui.ty = pan.ty
    paint(ui, false)
}

function onPointerUp(ui, event) {
    const point = ui.pointers.get(event.pointerId)
    ui.pointers.delete(event.pointerId)
    if (ui.pointers.size < 2) ui.pinch = null
    const tappedBackdrop = ui.downOnBackdrop && !ui.moved && ui.pointers.size === 0
    ui.drag = null
    ui.stage.classList.remove('is-dragging')
    if (tappedBackdrop) {
        requestClose(ui)
        return
    }
    if (event.pointerType === 'mouse' || !point || ui.pointers.size > 0) return
    const now = performance.now()
    if (now - ui.lastTap < 300 && Math.hypot(event.clientX - ui.lastTapX, event.clientY - ui.lastTapY) < 32) {
        ui.lastTap = 0
        toggleZoom(ui, event.clientX, event.clientY)
        return
    }
    ui.lastTap = now
    ui.lastTapX = event.clientX
    ui.lastTapY = event.clientY
}

function pinchFrom(ui) {
    const pts = [...ui.pointers.values()]
    const a = pts[0]
    const b = pts[1] || pts[0]
    return {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        scale: ui.scale
    }
}
