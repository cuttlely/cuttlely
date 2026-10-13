// Homepage media URLs carry a short content hash so a long browser cache can keep the file
// and still pick up a new encode. Computed when the page is built.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultPublic = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')

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
