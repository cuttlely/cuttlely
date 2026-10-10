import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const summary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.verify', 'verify-summary.md')

if (!fs.existsSync(summary)) {
    console.error('No verify summary. Run pnpm verify first.')
    process.exit(1)
}

process.stdout.write(fs.readFileSync(summary, 'utf8'))

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // printed above
}
