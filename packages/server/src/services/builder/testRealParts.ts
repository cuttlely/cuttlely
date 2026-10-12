import fs from 'fs'
import path from 'path'
import { PartDefinition } from './recipe'

// The real part classes from the built components package, found through its module catalog, so the classic
// canvas tests check plugs against the same types the canvas uses. Needs `pnpm build` (verify builds first).
const componentsDir = path.join(__dirname, '..', '..', '..', '..', 'components')
const repoRoot = path.join(componentsDir, '..', '..')

// Catalog paths are relative to the repository. Built classes sit under that package's dist.
function builtNodeFile(catalogFile: string): string {
    const js = catalogFile.replace(/\.ts$/, '.js').replace(/^packages\/([^/]+)\//, 'packages/$1/dist/')
    return path.join(repoRoot, js)
}

// Every part name in one folder of the nodes pool, like "tools".
export function partNamesIn(folder: string): string[] {
    const catalog: Array<{ name: string; file: string }> = JSON.parse(
        fs.readFileSync(path.join(componentsDir, 'nodes', 'module-catalog.json'), 'utf8')
    ).nodes
    return catalog.filter((item) => item.file.includes(`/nodes/${folder}/`)).map((item) => item.name)
}

export function realParts(names: string[]): Record<string, PartDefinition> {
    const catalog: Array<{ name: string; file: string }> = JSON.parse(
        fs.readFileSync(path.join(componentsDir, 'nodes', 'module-catalog.json'), 'utf8')
    ).nodes
    const parts: Record<string, PartDefinition> = {}
    for (const name of names) {
        const entry = catalog.find((item) => item.name === name)
        if (!entry) throw new Error(`${name} is not in the module catalog`)
        const file = builtNodeFile(entry.file)
        const { nodeClass } = require(file)
        parts[name] = new nodeClass()
    }
    return parts
}
