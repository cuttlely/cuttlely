import fs from 'fs'
import path from 'path'

export interface UiBuild {
    directory: string
    indexHtml: string
}

interface FoundUiBuild extends UiBuild {
    mtimeMs: number
}

function indexIfPresent(directory: string): FoundUiBuild | null {
    if (!directory) return null
    const indexHtml = path.join(directory, 'index.html')
    try {
        if (!fs.existsSync(indexHtml)) return null
        return { directory, indexHtml, mtimeMs: fs.statSync(indexHtml).mtimeMs }
    } catch {
        return null
    }
}

/**
 * Places the built UI may live.
 * The server build copies it to dist/ui, next to this file once compiled.
 * A later UI build writes a newer index.html under packages/ui/build.
 * The last candidate is a linked UI package, for a full install from source.
 */
export function uiBuildCandidates(startDir: string, packageDir = ''): string[] {
    const candidates = [path.resolve(startDir, '..', 'ui')]
    let dir = path.resolve(startDir)
    for (let i = 0; i < 8; i += 1) {
        candidates.push(path.join(dir, 'packages', 'ui', 'build'))
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    if (packageDir) candidates.push(path.join(packageDir, 'build'))
    return candidates
}

/** Newest built UI. Equal timestamps keep the earlier candidate. */
export function resolveUiBuild(packageDir = '', startDir = __dirname): UiBuild | null {
    let best: FoundUiBuild | null = null
    const seen = new Set<string>()
    for (const directory of uiBuildCandidates(startDir, packageDir)) {
        const resolved = path.resolve(directory)
        if (seen.has(resolved)) continue
        seen.add(resolved)
        const found = indexIfPresent(resolved)
        if (!found) continue
        if (!best || found.mtimeMs > best.mtimeMs) best = found
    }
    if (!best) return null
    return { directory: best.directory, indexHtml: best.indexHtml }
}
