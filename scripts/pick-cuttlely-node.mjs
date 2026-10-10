import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function nodeLoadsSqlite(execPath, args = []) {
    if (!execPath || !fs.existsSync(execPath)) return false
    const result = spawnSync(execPath, [...args, '-e', 'require("node:sqlite")'], { stdio: 'ignore' })
    return result.status === 0
}

export function nvmRoots() {
    const roots = []
    if (process.env.NVM_DIR) roots.push(path.join(process.env.NVM_DIR, 'versions', 'node'))
    roots.push(path.join(os.homedir(), '.nvm', 'versions', 'node'))
    return [...new Set(roots)]
}

export function nvmCandidates(roots = nvmRoots()) {
    let nvmrc = ''
    try {
        nvmrc = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim()
    } catch {
        nvmrc = ''
    }
    const preferred = []
    const rest = []
    for (const root of roots) {
        if (!fs.existsSync(root)) continue
        if (nvmrc) {
            const exact = path.join(root, nvmrc, 'bin', 'node')
            if (fs.existsSync(exact)) preferred.push(exact)
        }
        let names = []
        try {
            names = fs.readdirSync(root)
        } catch {
            names = []
        }
        const versions = names
            .filter((name) => /^v24\./.test(name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .reverse()
        for (const name of versions) {
            const bin = path.join(root, name, 'bin', 'node')
            if (fs.existsSync(bin)) rest.push(bin)
        }
    }
    return [...new Set([...preferred, ...rest])]
}

export function selectNode({ current = process.execPath, extra = [], probe = nodeLoadsSqlite } = {}) {
    if (probe(current, [])) return { execPath: current, args: [] }
    if (probe(current, ['--experimental-sqlite'])) return { execPath: current, args: ['--experimental-sqlite'] }
    for (const execPath of extra) {
        if (execPath === current) continue
        if (probe(execPath, [])) return { execPath, args: [] }
    }
    return null
}

function main() {
    const chosen = selectNode({ extra: nvmCandidates() })
    if (!chosen) {
        console.error(
            `Cuttlely needs Node 24. ETL opens its local database with the node:sqlite built-in.\nThis node is ${process.version} at ${process.execPath}.\nInstall the version in .nvmrc and run scripts/start-cuttlely.sh again.`
        )
        process.exit(1)
    }
    process.stdout.write(`${chosen.execPath}\n${chosen.args.join(' ')}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
