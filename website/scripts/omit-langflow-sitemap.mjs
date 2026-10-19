#!/usr/bin/env node
/* eslint-disable no-console -- build script; output is the interface */
// Drops the Langflow import page and the /migrate/ alias from sitemap XML after `astro build`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function omitLangflowImportFromSitemaps(dist) {
    if (!fs.existsSync(dist)) return 0
    let changed = 0
    for (const name of fs.readdirSync(dist)) {
        if (!/^sitemap.*\.xml$/.test(name)) continue
        const file = path.join(dist, name)
        const xml = fs.readFileSync(file, 'utf8')
        const next = xml
            .replace(/<url>\s*<loc>[^<]*langflow-import[^<]*<\/loc>[\s\S]*?<\/url>\s*/gi, '')
            .replace(/<url>\s*<loc>[^<]*\/migrate\/?<\/loc>[\s\S]*?<\/url>\s*/gi, '')
        if (next !== xml) {
            fs.writeFileSync(file, next)
            changed += 1
        }
    }
    return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dist = path.resolve(process.argv[2] || path.join(SITE, 'dist'))
    const n = omitLangflowImportFromSitemaps(dist)
    console.log(`omit-langflow-sitemap: updated ${n} file(s) in ${dist}`)
}
