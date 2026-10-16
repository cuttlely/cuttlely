// Fail when a tracked or staged image or video file is over 5 MB and is not in scripts/media-size.allowlist.
// The allowlist holds the large media that was already committed. A listed path that is no longer
// tracked, or no longer over the limit, fails until its line is removed, so the list only shrinks.
// Sizes are read from the working tree. Vendored hermes/ is skipped.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST = path.join(ROOT, 'scripts', 'media-size.allowlist')

export const LIMIT_BYTES = 5_000_000

export const MEDIA_EXTENSIONS = new Set([
    '.apng',
    '.avi',
    '.avif',
    '.bmp',
    '.gif',
    '.heic',
    '.ico',
    '.jpeg',
    '.jpg',
    '.m4v',
    '.mkv',
    '.mov',
    '.mp4',
    '.mpeg',
    '.mpg',
    '.ogv',
    '.png',
    '.psd',
    '.svg',
    '.tif',
    '.tiff',
    '.webm',
    '.webp'
])

export function isMedia(file) {
    return MEDIA_EXTENSIONS.has(path.extname(String(file || '')).toLowerCase())
}

export function parseAllowlist(text) {
    const entries = []
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        entries.push(line.replace(/\\/g, '/').replace(/^\.\//, ''))
    }
    return entries
}

// sizes maps a repository path to its size in bytes. Paths that are not media are ignored.
export function mediaProblems(sizes, allowlist, limit = LIMIT_BYTES) {
    const allowed = new Set(allowlist)
    const oversized = []
    for (const [file, bytes] of sizes) {
        if (file.startsWith('hermes/') || !isMedia(file)) continue
        if (bytes > limit && !allowed.has(file)) oversized.push({ file, bytes })
    }
    const stale = []
    for (const file of allowed) {
        const bytes = sizes.get(file)
        if (bytes === undefined || bytes <= limit) stale.push(file)
    }
    oversized.sort((a, b) => b.bytes - a.bytes)
    return { oversized, stale }
}

function gitLines(args) {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
}

export function trackedMediaSizes(root = ROOT) {
    const files = new Set([...gitLines(['ls-files']), ...gitLines(['diff', '--name-only', '--cached', '--diff-filter=AM'])])
    const sizes = new Map()
    for (const file of files) {
        if (!isMedia(file)) continue
        try {
            sizes.set(file, fs.statSync(path.join(root, file)).size)
        } catch {
            // Deleted in the working tree and not yet staged.
        }
    }
    return sizes
}

function megabytes(bytes) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function main() {
    const allowlist = parseAllowlist(fs.readFileSync(ALLOWLIST, 'utf8'))
    const sizes = trackedMediaSizes()
    const { oversized, stale } = mediaProblems(sizes, allowlist)
    console.log(`media size: ${sizes.size} image and video files, limit ${megabytes(LIMIT_BYTES)}, ${allowlist.length} allowlisted`)
    if (!oversized.length && !stale.length) {
        console.log('No new media over the limit.')
        return
    }
    if (oversized.length) {
        console.error(`Image or video files over ${megabytes(LIMIT_BYTES)}:`)
        for (const { file, bytes } of oversized) console.error(`  ${file} (${megabytes(bytes)})`)
        console.error(
            'Compress the file or host it outside the repository. scripts/media-size.allowlist is for media that was already committed.'
        )
    }
    if (stale.length) {
        console.error('Allowlisted paths that are gone or no longer over the limit. Remove these lines from scripts/media-size.allowlist:')
        for (const file of stale) console.error(`  ${file}`)
    }
    process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
