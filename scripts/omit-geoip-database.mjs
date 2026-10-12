#!/usr/bin/env node
// Leaves the IP geolocation database out of a production install when
// CUTTLELY_OMIT_GEOIP=true. Any other value keeps the package.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function drop(target, removed, root) {
    let stat
    try {
        stat = fs.lstatSync(target)
    } catch {
        return
    }
    if (!stat.isSymbolicLink() && !stat.isDirectory()) return
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(path.relative(root, target))
}

/**
 * Deletes the geoip-lite package from a pnpm install at `root`.
 * Returns the paths that were deleted, relative to `root`.
 */
export function omitGeoipDatabase(root) {
    const removed = []
    const nodeModules = path.join(root, 'node_modules')
    const store = path.join(nodeModules, '.pnpm')
    if (fs.existsSync(store)) {
        for (const name of fs.readdirSync(store)) {
            if (name === 'geoip-lite' || name.startsWith('geoip-lite@')) {
                drop(path.join(store, name), removed, root)
                continue
            }
            drop(path.join(store, name, 'node_modules', 'geoip-lite'), removed, root)
        }
    }
    drop(path.join(nodeModules, 'geoip-lite'), removed, root)
    const packagesDir = path.join(root, 'packages')
    if (fs.existsSync(packagesDir)) {
        for (const name of fs.readdirSync(packagesDir)) {
            drop(path.join(packagesDir, name, 'node_modules', 'geoip-lite'), removed, root)
        }
    }
    return removed
}

function main() {
    if (process.env.CUTTLELY_OMIT_GEOIP !== 'true') return
    const removed = omitGeoipDatabase(ROOT)
    if (removed.length === 0) {
        console.error('CUTTLELY_OMIT_GEOIP=true but the geolocation database package was not installed')
        process.exit(1)
    }
    console.info(`Left out the IP geolocation database (${removed.length} paths)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main()
}
