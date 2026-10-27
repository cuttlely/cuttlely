// Node 24 resolves an explicit test directory through its index module.
import fs from 'node:fs'

for (const file of fs
    .readdirSync(import.meta.dirname)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()) {
    await import(new URL(file, import.meta.url))
}
