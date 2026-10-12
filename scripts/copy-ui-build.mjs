/* eslint-disable no-console -- command-line step; the line it prints is the result */
// Copy packages/ui/build into the server build output.
// A missing UI build is not an error here: a server-only compile still succeeds,
// and the image check requires the copy after the full build.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'packages', 'ui', 'build')
const dest = path.join(root, 'packages', 'server', 'dist', 'ui')
const indexHtml = path.join(source, 'index.html')

if (!fs.existsSync(indexHtml)) {
    console.error('UI build is not at packages/ui/build yet. Build @cuttlely/ui, then build the server, to copy it.')
    process.exit(0)
}

fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.rmSync(dest, { recursive: true, force: true })
fs.cpSync(source, dest, { recursive: true })
console.log('Copied the UI build to packages/server/dist/ui')
