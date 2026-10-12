#!/usr/bin/env node
// Leaves optional node packs out of a production install when INCLUDE_NODE_PACKS=0.
// Any other value keeps every pack. A pack is a workspace package whose name starts
// with @cuttlely/node-pack-. Dependencies that another package still needs stay.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

function depNames(pkg) {
    if (!pkg || typeof pkg.dependencies !== 'object' || pkg.dependencies == null) return []
    return Object.keys(pkg.dependencies)
}

function optionalNames(pkg) {
    if (!pkg || typeof pkg.optionalDependencies !== 'object' || pkg.optionalDependencies == null) return []
    return Object.keys(pkg.optionalDependencies)
}

export function isNodePackName(name) {
    return typeof name === 'string' && name.startsWith('@cuttlely/node-pack-')
}

function workspaceManifests(root) {
    const found = []
    const rootPkg = readJson(path.join(root, 'package.json'))
    if (rootPkg) found.push(rootPkg)
    const packagesDir = path.join(root, 'packages')
    if (!fs.existsSync(packagesDir)) return found
    for (const name of fs.readdirSync(packagesDir)) {
        const pkg = readJson(path.join(packagesDir, name, 'package.json'))
        if (pkg) found.push(pkg)
    }
    return found
}

function realPackageNames(storeEntry) {
    const nodeModules = path.join(storeEntry, 'node_modules')
    if (!fs.existsSync(nodeModules)) return []
    const names = []
    const visit = (dir, depth) => {
        let entries
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue
            const full = path.join(dir, entry.name)
            if (!entry.isDirectory()) continue
            const manifest = path.join(full, 'package.json')
            if (fs.existsSync(manifest)) {
                const pkg = readJson(manifest)
                if (pkg && typeof pkg.name === 'string') names.push(pkg.name)
                continue
            }
            if (depth < 2) visit(full, depth + 1)
        }
    }
    visit(nodeModules, 0)
    return names
}

function dependencyIndex(root) {
    const depsByName = new Map()
    const store = path.join(root, 'node_modules', '.pnpm')
    if (!fs.existsSync(store)) return depsByName
    for (const entry of fs.readdirSync(store)) {
        const dir = path.join(store, entry)
        let stat
        try {
            stat = fs.lstatSync(dir)
        } catch {
            continue
        }
        if (!stat.isDirectory() || entry === 'node_modules') continue
        for (const name of realPackageNames(dir)) {
            const manifestPath = findManifest(dir, name)
            const pkg = manifestPath ? readJson(manifestPath) : null
            const deps = [...depNames(pkg), ...optionalNames(pkg)]
            const previous = depsByName.get(name)
            depsByName.set(name, previous ? previous.concat(deps) : deps)
        }
    }
    return depsByName
}

function findManifest(storeEntry, packageName) {
    const nodeModules = path.join(storeEntry, 'node_modules')
    const parts = packageName.startsWith('@') ? packageName.split('/') : [packageName]
    const candidate = path.join(nodeModules, ...parts, 'package.json')
    if (fs.existsSync(candidate)) return candidate
    return ''
}

/**
 * Packages that must stay: production dependencies of every workspace package
 * that is not itself a node pack, plus the dependencies those packages install.
 */
export function packagesToKeep(root) {
    const manifests = workspaceManifests(root)
    const byName = new Map(manifests.filter((pkg) => typeof pkg.name === 'string').map((pkg) => [pkg.name, pkg]))
    const installed = dependencyIndex(root)
    const keep = new Set()
    const queue = []
    const consider = (name) => {
        if (!name || isNodePackName(name) || keep.has(name)) return
        keep.add(name)
        queue.push(name)
    }
    for (const pkg of manifests) {
        if (isNodePackName(pkg.name)) continue
        if (typeof pkg.name === 'string') consider(pkg.name)
        for (const name of depNames(pkg)) consider(name)
    }
    while (queue.length) {
        const name = queue.pop()
        const workspace = byName.get(name)
        if (workspace && !isNodePackName(workspace.name)) {
            for (const dep of depNames(workspace)) consider(dep)
        }
        for (const dep of installed.get(name) || []) consider(dep)
    }
    return keep
}

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

function packageNameAt(dir) {
    const pkg = readJson(path.join(dir, 'package.json'))
    if (pkg && typeof pkg.name === 'string') return pkg.name
    return ''
}

function dropNamedLinks(dir, keep, removed, root) {
    if (!fs.existsSync(dir)) return
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        if (entry.name === '.pnpm' || entry.name === '.bin' || entry.name === '.modules.yaml') continue
        const full = path.join(dir, entry.name)
        if (entry.name.startsWith('@') && entry.isDirectory() && !entry.isSymbolicLink()) {
            dropNamedLinks(full, keep, removed, root)
            continue
        }
        let stat
        try {
            stat = fs.lstatSync(full)
        } catch {
            continue
        }
        if (!stat.isSymbolicLink() && !stat.isDirectory()) continue
        const name = entry.name.startsWith('@') ? '' : packageNameAt(full) || entry.name
        const scoped = path.basename(dir).startsWith('@') ? `${path.basename(dir)}/${entry.name}` : name
        const packageName = path.basename(dir).startsWith('@') ? scoped : name
        if (!packageName || keep.has(packageName)) continue
        if (!isNodePackName(packageName) && keep.has(packageName)) continue
        drop(full, removed, root)
    }
}

/**
 * Deletes node-pack packages and the production dependencies only they need.
 * Returns the paths that were deleted, relative to `root`.
 */
export function omitNodePacks(root) {
    const keep = packagesToKeep(root)
    const removed = []
    const store = path.join(root, 'node_modules', '.pnpm')
    if (fs.existsSync(store)) {
        for (const entry of fs.readdirSync(store)) {
            const dir = path.join(store, entry)
            let stat
            try {
                stat = fs.lstatSync(dir)
            } catch {
                continue
            }
            if (!stat.isDirectory() || entry === 'node_modules') continue
            const names = realPackageNames(dir)
            if (names.length === 0) continue
            if (names.every((name) => keep.has(name))) continue
            if (names.some((name) => keep.has(name)) && names.some((name) => !keep.has(name))) {
                // A store folder that mixes a kept package with something else stays.
                // pnpm keeps one package per folder; this guards a layout we do not expect.
                continue
            }
            drop(dir, removed, root)
        }
    }
    dropNamedLinks(path.join(root, 'node_modules'), keep, removed, root)
    const packagesDir = path.join(root, 'packages')
    if (fs.existsSync(packagesDir)) {
        for (const name of fs.readdirSync(packagesDir)) {
            dropNamedLinks(path.join(packagesDir, name, 'node_modules'), keep, removed, root)
        }
    }
    return removed
}

function main() {
    if (process.env.INCLUDE_NODE_PACKS !== '0') return
    const removed = omitNodePacks(ROOT)
    if (removed.length === 0) {
        console.error('INCLUDE_NODE_PACKS=0 but no node pack packages were installed')
        process.exit(1)
    }
    console.info(`Left out optional node packs (${removed.length} paths)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main()
}
