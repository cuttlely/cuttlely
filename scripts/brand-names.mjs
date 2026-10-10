// Fails when an image file name, or the alt text, title or caption of an image in the docs, still uses the old product name.
// Run: node scripts/brand-names.mjs   (exit 1 and a list when something is found)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OLD = ['den', 'flow'].join('') // spelled in two parts so this file does not match itself
const OLD_RE = new RegExp(OLD, 'i')
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i
const SKIP = [/^hermes\//, /^\.projects\//, /(^|\/)node_modules\//]

export function oldNameInImageNames(files) {
    return files
        .filter((f) => IMAGE_RE.test(f) && !SKIP.some((re) => re.test(f)) && OLD_RE.test(path.basename(f)))
        .map((f) => ({ file: f, why: 'image file name' }))
}

export function oldNameInCaptions(file, text) {
    const found = []
    const lines = text.split('\n')
    lines.forEach((line, i) => {
        const at = `${file}:${i + 1}`
        for (const m of line.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g)) {
            if (OLD_RE.test(m[1] || '')) found.push({ file: at, why: 'image alt text' })
            if (OLD_RE.test(m[3] || '')) found.push({ file: at, why: 'image title' })
        }
        for (const m of line.matchAll(/<img\b[^>]*>/gi)) {
            const alt = /\balt\s*=\s*"([^"]*)"/i.exec(m[0])
            const title = /\btitle\s*=\s*"([^"]*)"/i.exec(m[0])
            if (alt && OLD_RE.test(alt[1])) found.push({ file: at, why: 'image alt text' })
            if (title && OLD_RE.test(title[1])) found.push({ file: at, why: 'image title' })
        }
        for (const m of line.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/gi)) {
            if (OLD_RE.test(m[1])) found.push({ file: at, why: 'image caption' })
        }
        // An italic line right under an image is a caption: ![..](..) then *Caption* or _Caption_.
        const prev = i > 0 ? lines[i - 1] : ''
        if (/!\[[^\]]*\]\([^)]+\)\s*$|<img\b[^>]*>\s*$/i.test(prev) && /^\s*(\*[^*].*\*|_[^_].*_)\s*$/.test(line) && OLD_RE.test(line)) {
            found.push({ file: at, why: 'image caption' })
        }
    })
    return found
}

export function scan(root) {
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    const found = oldNameInImageNames(files)
    for (const f of files) {
        if (!/\.(md|mdx|html)$/i.test(f) || SKIP.some((re) => re.test(f))) continue
        found.push(...oldNameInCaptions(f, fs.readFileSync(path.join(root, f), 'utf8')))
    }
    return found
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const found = scan(root)
    if (found.length) {
        console.error(`The old product name is still in ${found.length} image name(s) or caption(s):`)
        for (const f of found) console.error(`  ${f.file}  (${f.why})`)
        process.exit(1)
    }
    console.log('brand names: no image name or caption uses the old product name')
}
