// Homepage media URLs carry a short content hash so a long browser cache can keep the file
// and still pick up a new encode. Computed when the page is built. Markdown that cannot call
// this module inlines the same `?v=` query by hand; check-site and the website tests fail a
// link that is missing it or whose hash does not match the file.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultPublic = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const SITE_ORIGIN = 'https://cuttlely.com'
const SKIP_DIRS = new Set(['node_modules', 'dist', 'content', '.git', 'hermes'])

/** First 8 hex characters of the sha256 of the bytes. */
export function mediaHash(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8)
}

/** `/media/...` plus `?v=` from the file in the site's public directory. */
export function mediaUrl(urlPath, publicDir = defaultPublic) {
    const clean = String(urlPath).split('?')[0]
    const rel = clean.replace(/^\//, '')
    const hash = mediaHash(fs.readFileSync(path.join(publicDir, rel)))
    return `${clean}?v=${hash}`
}

/**
 * Link-like `/media/` URLs, with or without the site origin and `?v=`.
 * File paths such as `website/public/media/...` and `mediaUrl('/media/...')` are not links.
 */
export const MEDIA_HREF_RE = /(?:https:\/\/cuttlely\.com\/media\/|\/media\/)[A-Za-z0-9._\-/]+(?:\?v=[0-9a-f]+)?/g

/** `/media/...` from a root-relative href or one on the site origin. A lookalike host is left as-is. */
export function localMediaHref(href) {
    return href.startsWith('https://cuttlely.com/') ? href.slice(SITE_ORIGIN.length) : href
}

export function mediaHrefs(text) {
    const out = []
    const re = new RegExp(MEDIA_HREF_RE.source, 'g')
    for (const match of String(text).matchAll(re)) {
        const before = String(text).slice(Math.max(0, match.index - 24), match.index)
        if (before.endsWith('public')) continue
        if (/mediaUrl\s*\(\s*['"`]$/.test(before)) continue
        out.push(match[0])
    }
    return out
}

/** Hrefs whose `?v=` is missing, malformed, or not the hash of the public file. */
export function mediaHrefProblems(text, publicDir = defaultPublic) {
    const problems = []
    for (const href of mediaHrefs(text)) {
        const local = localMediaHref(href)
        const clean = local.split('?')[0]
        const v = new URLSearchParams(local.split('?')[1] || '').get('v')
        if (!v || !/^[0-9a-f]{8}$/.test(v)) {
            problems.push(href)
            continue
        }
        const file = path.join(publicDir, clean.replace(/^\//, ''))
        if (!fs.existsSync(file)) continue
        if (local !== mediaUrl(clean, publicDir)) problems.push(href)
    }
    return problems
}

function walkMarkdown(dir, root, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
            walkMarkdown(path.join(dir, entry.name), root, out)
            continue
        }
        if (!entry.name.endsWith('.md')) continue
        out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'))
    }
    return out
}

/** Unhashed or stale `/media/` links in repository markdown. */
export function repoMediaLinkProblems(repoRoot, publicDir = defaultPublic) {
    const problems = []
    for (const rel of walkMarkdown(repoRoot, repoRoot, [])) {
        const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8')
        for (const href of mediaHrefProblems(text, publicDir)) {
            problems.push(`${rel}: unhashed or stale media link ${href}`)
        }
    }
    return problems
}
