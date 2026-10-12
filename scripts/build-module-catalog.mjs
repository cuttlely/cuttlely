import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodesRoot = path.join(root, 'packages/components/nodes')

// Built-in nodes, plus every packages/node-pack-*/nodes directory. A new pack is picked up here.
function nodeRoots() {
    const roots = [nodesRoot]
    const packagesDir = path.join(root, 'packages')
    if (!fs.existsSync(packagesDir)) return roots
    for (const name of fs.readdirSync(packagesDir)) {
        if (!name.startsWith('node-pack-')) continue
        const nodes = path.join(packagesDir, name, 'nodes')
        if (fs.existsSync(nodes)) roots.push(nodes)
    }
    return roots
}
const TIERS = ['core', 'supported', 'legacy', 'hidden']

// The same canvases the template open check reads: marketplace templates and the stock samples.
const CANVAS_DIRS = [
    'packages/server/marketplaces/chatflows',
    'packages/server/marketplaces/agentflows',
    'packages/server/marketplaces/agentflowsv2',
    'samples/chatflows',
    'samples/harnesses',
    'samples/etl'
]

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

function resolveImport(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec)
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.mjs`,
        path.join(base, 'index.ts'),
        path.join(base, 'index.js')
    ]
    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || ''
}

function constantString(source, file, name, seen) {
    const key = `${file}\0${name}`
    if (seen.has(key)) return ''
    seen.add(key)
    const local = source.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`))
    if (local) return local[1]
    const importRe = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g
    let match
    while ((match = importRe.exec(source))) {
        const imported = match[1].split(',').map((part) =>
            part
                .trim()
                .split(/\s+as\s+/)[0]
                .trim()
        )
        if (!imported.includes(name)) continue
        const target = resolveImport(file, match[2])
        if (!target) continue
        return constantString(fs.readFileSync(target, 'utf8'), target, name, seen)
    }
    return ''
}

function categoryOf(source, file) {
    const literal = quotedField(source, 'category')
    if (literal) return literal
    const ident = source.match(/this\.category\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    if (!ident) return ''
    return constantString(source, file, ident, new Set()) || ''
}

// Categories NodesPool does not register. hidden follows that list.
function skippedCategories() {
    const source = fs.readFileSync(path.join(root, 'packages/server/src/NodesPool.ts'), 'utf8')
    const list = source.match(/const skipCategories = \[([^\]]*)\]/)
    if (!list) throw new Error('NodesPool skipCategories was not found')
    return new Set([...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]))
}

function flowOf(record) {
    const raw = record.flowData === undefined ? record : record.flowData
    return typeof raw === 'string' ? JSON.parse(raw) : raw
}

function namesInCanvases(known) {
    const found = new Set()
    const take = (value) => {
        if (known.has(value)) found.add(value)
    }
    for (const dir of CANVAS_DIRS) {
        const abs = path.join(root, dir)
        if (!fs.existsSync(abs)) continue
        for (const file of fs.readdirSync(abs)) {
            if (!file.endsWith('.json')) continue
            const flow = flowOf(JSON.parse(fs.readFileSync(path.join(abs, file), 'utf8')))
            for (const node of flow?.nodes || []) {
                const data = node?.data || {}
                take(data.name)
                const inputs = data.inputs || {}
                take(inputs.toolAgentflowSelectedTool)
                if (Array.isArray(inputs.agentTools)) {
                    for (const tool of inputs.agentTools) take(tool?.agentSelectedTool)
                }
            }
        }
    }
    return found
}

function namesInRecipes(known) {
    const dir = path.join(root, 'packages/server/src/services/builder/recipes')
    const found = new Set()
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
        const text = fs.readFileSync(path.join(dir, file), 'utf8')
        for (const match of text.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g)) {
            if (known.has(match[1])) found.add(match[1])
        }
    }
    return found
}

// hidden, then legacy, then core. A badge or a skipped category wins over a template mention.
function tierFor(node, skip, coreNames) {
    if (skip.has(node.category)) return 'hidden'
    if (node.badge === 'DEPRECATING') return 'legacy'
    if (coreNames.has(node.name)) return 'core'
    return 'supported'
}

function collectNodes(dir, nodes) {
    for (const file of walk(dir)) {
        const source = fs.readFileSync(file, 'utf8')
        if (!source.includes('nodeClass')) continue
        const name = quotedField(source, 'name')
        if (!name) continue
        const label = quotedField(source, 'label') || name
        const category = categoryOf(source, file)
        const badge = quotedField(source, 'badge') || ''
        const deprecated = source.match(/this\.deprecateMessage\s*=\s*['"`]([^'"`]+)['"`]/)?.[1] || ''
        const relative = path.relative(root, file)
        const folder = relative.split(path.sep)[3] || ''
        const datedRuntime =
            ['agents', 'sequentialagents', 'multiagents', 'graphs'].includes(folder) || source.includes('@langchain/langgraph')
        let disposition = 'native'
        let reason = 'Runs on the current node interface. A harness binds it through init and run.'
        if (deprecated) {
            disposition = 'replaced'
            reason = `Marked deprecated in place. Not deleted. ${deprecated}`
        } else if (datedRuntime) {
            disposition = 'adapt'
            reason = 'Older agent or LangGraph 0.0.22 runtime. Convert only when a harness binding cannot load it.'
        }
        nodes.push({ name, label, category, folder, file: relative, disposition, reason, badge })
    }
}

export function buildModuleCatalog() {
    const nodes = []
    for (const dir of nodeRoots()) collectNodes(dir, nodes)

    nodes.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
    const known = new Set(nodes.map((node) => node.name))
    const coreNames = namesInCanvases(known)
    for (const name of namesInRecipes(known)) coreNames.add(name)
    const skip = skippedCategories()

    const counts = { native: 0, adapt: 0, replaced: 0 }
    const tiers = { core: 0, supported: 0, legacy: 0, hidden: 0 }
    for (const node of nodes) {
        counts[node.disposition] += 1
        node.tier = tierFor(node, skip, coreNames)
        tiers[node.tier] += 1
        delete node.badge
    }

    return {
        generatedFrom: 'packages/components/nodes and packages/node-pack-*/nodes',
        registration:
            'NodesPool loads every nodeClass under packages/components/nodes, then the packs in CUTTLELY_NODE_PACKS. Unset loads the packs that ship with the install. packages/components/nodes/index.ts re-exports this catalog. tier is core (a bundled template, a sample canvas, or a Build with AI recipe), supported, legacy (DEPRECATING badge), or hidden (a category the server skips at load).',
        langgraphUpgradeBlocked: false,
        counts,
        tiers,
        nodes
    }
}

function main() {
    const jsonPath = path.join(nodesRoot, 'module-catalog.json')
    const catalog = buildModuleCatalog()
    const text = `${JSON.stringify(catalog, null, 4)}\n`
    const check = process.argv.includes('--check')
    if (check) {
        const current = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, 'utf8') : ''
        if (current !== text) {
            console.error('module catalog is stale. Run node scripts/build-module-catalog.mjs')
            process.exit(1)
        }
    } else {
        fs.writeFileSync(jsonPath, text)
    }
    const { counts, tiers } = catalog
    console.log(
        `catalog ${catalog.nodes.length} nodes native=${counts.native} adapt=${counts.adapt} replaced=${counts.replaced} tiers core=${tiers.core} supported=${tiers.supported} legacy=${tiers.legacy} hidden=${tiers.hidden}`
    )
    if (!TIERS.every((name) => Number.isInteger(tiers[name]))) {
        console.error('tier counts are missing')
        process.exit(1)
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
