// Inspect exported teams before selecting the native runtime. The graph compiler's
// published-record lookup is disabled so an unrelated local install cannot supply bindings.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeCompatibilityGaps } from '../packages/harness/runtime/native-prime.mjs'
import { rosterFromFlow } from '../packages/harness/sync-from-flow.mjs'

export function inspectExport(value) {
    const rows = Array.isArray(value) ? value : [value]
    const teams = []
    for (const row of rows) {
        if (row?.type && row.type !== 'HARNESS') continue
        const team = typeof row?.name === 'string' ? row.name.slice(0, 256) : null
        let graph = row?.flowData ?? row
        try {
            if (typeof graph === 'string') graph = JSON.parse(graph)
            if (row?.type !== 'HARNESS' && !graph?.nodes?.some((node) => node.data?.name === 'harnessChief')) continue
            const workspaceId = typeof row?.workspaceId === 'string' ? row.workspaceId : undefined
            const roster = rosterFromFlow({ name: 'export-preview', flowData: graph, workspaceId }, { inheritSavedFields: false })
            const gaps = nativeCompatibilityGaps(roster)
            teams.push({
                team,
                specialists: roster.specialists.length,
                status: gaps.length ? 'requires-bundled-runtime' : 'ready-for-runtime-test',
                gaps
            })
        } catch {
            // Parser errors can contain rejected graph input; emit only a fixed diagnostic.
            teams.push({ team, status: 'invalid-canvas' })
        }
    }
    return teams
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const files = process.argv.slice(2)
    if (!files.length) {
        console.error('Usage: node scripts/kraken-preflight.mjs <canvas-export.json | -> [...]')
        process.exitCode = 2
    }
    for (const file of files) {
        try {
            const teams = inspectExport(JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8')))
            console.log(JSON.stringify({ file, teams }))
            if (!teams.length || teams.some((row) => row.status === 'invalid-canvas')) process.exitCode = 2
            else if (!process.exitCode && teams.some((row) => row.gaps.length)) process.exitCode = 1
        } catch {
            console.error('Could not read the canvas export as JSON.')
            process.exitCode = 2
        }
    }
}
