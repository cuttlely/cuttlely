#!/usr/bin/env node
// Maps each node name and label under packages/node-pack-*/nodes to that pack's package name.
// The server reads the JSON in every image, including one built with INCLUDE_NODE_PACKS=0.
// A new pack is picked up here: any packages/node-pack-* directory with a nodes folder.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INDEX_PATH = path.join(ROOT, 'packages/server/src/utils/node-pack-index.json')
const DIST_INDEX_PATH = path.join(ROOT, 'packages/server/dist/utils/node-pack-index.json')

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, files)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.')) files.push(full)
    }
    return files
}

function quotedField(source, field) {
    return source.match(new RegExp(`this\\.${field}\\s*=\\s*['"]([^'"]+)['"]`))?.[1]
}

function exportsNodeClass(source) {
    return /nodeClass\s*:/.test(source) || /exports\.nodeClass\s*=/.test(source)
}

export function buildNodePackIndex(root = ROOT) {
    const packagesDir = path.join(root, 'packages')
    const nodes = []
    if (!fs.existsSync(packagesDir)) return { nodes }
    const packDirs = fs
        .readdirSync(packagesDir)
        .filter((name) => name.startsWith('node-pack-'))
        .sort()
    for (const dirName of packDirs) {
        const packRoot = path.join(packagesDir, dirName)
        const nodesDir = path.join(packRoot, 'nodes')
        if (!fs.existsSync(nodesDir)) continue
        const manifest = readJson(path.join(packRoot, 'package.json'))
        const pack = manifest && typeof manifest.name === 'string' ? manifest.name.trim() : ''
        if (!pack) throw new Error(`${dirName} has no package name`)
        for (const file of walk(nodesDir)) {
            const source = fs.readFileSync(file, 'utf8')
            if (!exportsNodeClass(source)) continue
            const name = quotedField(source, 'name')
            const relative = path.relative(root, file)
            if (!name) throw new Error(`${relative} exports nodeClass but has no this.name string`)
            const label = quotedField(source, 'label') || name
            nodes.push({ name, label, pack })
        }
    }
    nodes.sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name) || a.label.localeCompare(b.label))
    const seen = new Set()
    for (const node of nodes) {
        if (seen.has(node.name)) throw new Error(`node name ${node.name} is in more than one pack`)
        seen.add(node.name)
    }
    return { nodes }
}

export function indexText(index) {
    return `${JSON.stringify(index, null, 4)}\n`
}

function writeIndex(text) {
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true })
    fs.writeFileSync(INDEX_PATH, text)
    if (fs.existsSync(path.dirname(DIST_INDEX_PATH))) {
        fs.writeFileSync(DIST_INDEX_PATH, text)
    }
}

function main() {
    const index = buildNodePackIndex()
    const text = indexText(index)
    const check = process.argv.includes('--check')
    if (check) {
        const current = fs.existsSync(INDEX_PATH) ? fs.readFileSync(INDEX_PATH, 'utf8') : ''
        if (current !== text) {
            console.error('node pack index is stale. Run node scripts/build-node-pack-index.mjs')
            process.exit(1)
        }
        return
    }
    writeIndex(text)
    console.info(`node pack index: ${index.nodes.length} nodes`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main()
}
