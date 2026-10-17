// The benchmark whitepaper in assets/whitepaper/ is the only copy. The site serves it under /whitepaper/ from there,
// so the PDF and the web version are never duplicated into website/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_URL } from './site-config.mjs'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const WHITEPAPER_DIR = path.resolve(SITE, '..', 'assets', 'whitepaper')
export const WHITEPAPER_PDF = 'cuttlely-benchmark-whitepaper.pdf'
export const WHITEPAPER_HTML = 'cuttlely-benchmark-whitepaper.html'
export const WHITEPAPER_ROUTE = '/whitepaper/'

export function whitepaperPdf(dir = WHITEPAPER_DIR) {
    return fs.readFileSync(path.join(dir, WHITEPAPER_PDF))
}

/**
 * The web version as written, with only the tags every site page carries added to its head: a canonical link and the
 * link preview image. The body is not touched.
 */
export function whitepaperHtml(source) {
    const tags = [
        `<link rel="canonical" href="${SITE_URL}${WHITEPAPER_ROUTE}${WHITEPAPER_HTML}">`,
        `<meta property="og:image" content="${SITE_URL}/social/og-light.png">`
    ].join('\n')
    if (!/<\/head>/i.test(source)) throw new Error(`${WHITEPAPER_HTML} has no </head>`)
    return source.replace(/<\/head>/i, `${tags}\n</head>`)
}

export function whitepaperPage(dir = WHITEPAPER_DIR) {
    return whitepaperHtml(fs.readFileSync(path.join(dir, WHITEPAPER_HTML), 'utf8'))
}
