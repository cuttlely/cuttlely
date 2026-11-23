// The product version the website must show. Read at site build time from the
// repository release source of truth: the root package.json version.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function packageName(dir) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return null
    try {
        return JSON.parse(readFileSync(pkgPath, 'utf8')).name
    } catch {
        return null
    }
}

/** Walk up from start until the repo root (cuttlely-workspace + CHANGELOG.md). */
export function findRepoRoot(start = SCRIPT_DIR) {
    let dir = start
    while (true) {
        if (packageName(dir) === 'cuttlely-workspace' && existsSync(join(dir, 'CHANGELOG.md'))) {
            return dir
        }
        const parent = dirname(dir)
        if (parent === dir) {
            throw new Error(`cannot find the cuttlely-workspace root from ${start}`)
        }
        dir = parent
    }
}

export function repoRoot() {
    return findRepoRoot()
}

export function releaseVersion(root = findRepoRoot()) {
    const pkgPath = join(root, 'package.json')
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`root package.json version is not a release: ${JSON.stringify(version)}`)
    }
    return version
}

// Use the published README headline so the homepage and its badge change on the same release commit.
export function releaseHeadline(version, root = findRepoRoot()) {
    const prefix = `**${version} `
    const line = readFileSync(join(root, 'README.md'), 'utf8')
        .split(/\r?\n/)
        .find((entry) => entry.startsWith(prefix))
    const end = line?.indexOf('**', prefix.length) ?? -1
    if (end < 0) throw new Error(`README.md has no release headline for ${version}`)
    return `Cuttlely ${line.slice(prefix.length, end)}`
}

/** The latest dated heading in CHANGELOG.md, skipping ## [Unreleased]. */
export function changelogLatestVersion(root = findRepoRoot()) {
    const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
    const match = md.match(/^## \[(\d+\.\d+\.\d+)\]\s+-/m)
    if (!match) {
        throw new Error('CHANGELOG.md has no dated release heading')
    }
    return match[1]
}
