import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodesRoot = path.join(root, 'packages/components/nodes')

function walk(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, files)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.')) files.push(full)
    }
    return files
}

const nodes = []
for (const file of walk(nodesRoot)) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes('nodeClass')) continue
    const name = source.match(/this\.name\s*=\s*['"]([^'"]+)['"]/)?.[1]
    if (!name) continue
    const label = source.match(/this\.label\s*=\s*['"]([^'"]+)['"]/)?.[1] || name
    const category = source.match(/this\.category\s*=\s*['"]([^'"]+)['"]/)?.[1] || ''
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
    nodes.push({ name, label, category, folder, file: relative, disposition, reason })
}

nodes.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
const counts = { native: 0, adapt: 0, replaced: 0 }
for (const node of nodes) counts[node.disposition] += 1

const catalog = {
    generatedFrom: 'packages/components/nodes',
    registration: 'NodesPool loads every nodeClass under packages/components/nodes. packages/components/nodes/index.ts re-exports this catalog.',
    langgraphUpgradeBlocked: false,
    counts,
    nodes
}

const jsonPath = path.join(nodesRoot, 'module-catalog.json')
fs.writeFileSync(jsonPath, JSON.stringify(catalog, null, 2) + '\n')
console.log(`catalog ${nodes.length} nodes native=${counts.native} adapt=${counts.adapt} replaced=${counts.replaced}`)
