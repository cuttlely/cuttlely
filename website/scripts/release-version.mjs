// The product version the website must show. Read at site build time from the
// repository release source of truth: the root package.json version.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

export function repoRoot() {
    return ROOT
}

export function releaseVersion(root = ROOT) {
    const pkgPath = join(root, 'package.json')
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`root package.json version is not a release: ${JSON.stringify(version)}`)
    }
    return version
}

/** The latest dated heading in CHANGELOG.md, skipping ## [Unreleased]. */
export function changelogLatestVersion(root = ROOT) {
    const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
    const match = md.match(/^## \[(\d+\.\d+\.\d+)\]\s+-/m)
    if (!match) {
        throw new Error('CHANGELOG.md has no dated release heading')
    }
    return match[1]
}
