// Rewrites built HTML so content screenshots are links to the full image.
// Runs from the Astro build hook, before check-site. No-JS visitors follow the link.
import fs from 'node:fs'
import path from 'node:path'
import { wrapZoomableImages } from '../src/scripts/screenshot-zoom.mjs'

function htmlFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) htmlFiles(full, out)
        else if (entry.name.endsWith('.html')) out.push(full)
    }
    return out
}

export function applyScreenshotZoom(dist) {
    let pages = 0
    let images = 0
    for (const file of htmlFiles(dist)) {
        const html = fs.readFileSync(file, 'utf8')
        if (!html.includes('data-screenshot-zoom')) continue
        const next = wrapZoomableImages(html)
        if (next === html) continue
        fs.writeFileSync(file, next)
        pages += 1
        const before = html.match(/class="cl-zoom"/g)?.length || 0
        const after = next.match(/class="cl-zoom"/g)?.length || 0
        images += Math.max(0, after - before)
    }
    console.log(`screenshot-zoom: linked ${images} content image(s) on ${pages} page(s)`)
    return { pages, images }
}
