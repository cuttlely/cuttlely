import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(args) {
    const result = spawnSync('pnpm', ['exec', 'tsc', ...args], { cwd: ROOT, stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status === null ? 1 : result.status)
}

function main() {
    // Server imports @cuttlely/components types from packages/components/dist.
    // emitDeclarationOnly typechecks components and writes the .d.ts files that check needs.
    console.log('typecheck @cuttlely/components')
    run(['--emitDeclarationOnly', '-p', 'packages/components/tsconfig.json'])
    console.log('typecheck flowise')
    run(['--noEmit', '-p', 'packages/server/tsconfig.json'])
    console.log('typecheck flowise-ui: no TypeScript project; the UI build step covers that package')
    // CI runs `pnpm build`, which includes the API docs package. The verify build step does not.
    // `tsc --noEmit` is the type check that package runs (its build script is tsc only).
    console.log('typecheck flowise-api')
    run(['--noEmit', '-p', 'packages/api-documentation/tsconfig.json'])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
