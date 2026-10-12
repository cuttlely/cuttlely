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
    console.log('typecheck @cuttlely/node-pack-vector-stores')
    run(['--noEmit', '-p', 'packages/node-pack-vector-stores/tsconfig.json'])
    // The server imports this package. Emit it before the server check so the types resolve.
    console.log('typecheck @cuttlely/versioning')
    run(['--noEmit', '-p', 'packages/versioning/tsconfig.typecheck.json'])
    run(['-p', 'packages/versioning/tsconfig.json'])
    console.log('typecheck @cuttlely/server')
    run(['--noEmit', '-p', 'packages/server/tsconfig.json'])
    console.log('typecheck @cuttlely/ui: no TypeScript project; the UI build step covers that package')
    // CI runs `pnpm build`, which includes the API docs package. The verify build step does not.
    // `tsc --noEmit` is the type check that package runs (its build script is tsc only).
    console.log('typecheck @cuttlely/api-docs')
    run(['--noEmit', '-p', 'packages/api-documentation/tsconfig.json'])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
