#!/usr/bin/env node
/* eslint-disable no-console -- command-line tool; output is the interface */
// Checks a source export before it leaves Cuttlely. The project notes in `.projects/cuttlely/` ship with the
// repository and are allowed. The check fails on any other `.projects/` folder, on the private records folder
// `.projects/cuttlely/provenance/`, and on the files that stay out of every export (EXCLUDED_FILES and
// EXCLUDED_PATTERNS below).
//
// Usage:
//   node scripts/check-clean-export.mjs <export-dir>
//   node scripts/check-clean-export.mjs --files <list-file|-> [--root <dir>]
// With --files, each line of the list is a path relative to --root (default: the current directory). Add --json for
// machine-readable output. Exit code 0 = clean, 1 = violations, 2 = usage error.
import fs from 'fs'
import path from 'path'

export const PUBLIC_NOTES = '.projects/cuttlely/'
export const PRIVATE_NOTES = ['.projects/cuttlely/provenance/']
export const EXCLUDED_FILES = ['PROVENANCE.md', 'docs/product-identity.md']
export const EXCLUDED_PATTERNS = [/^scripts\/identity-[^/]+-evidence\.md$/]

function normalize(relPath) {
    return String(relPath || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
}

export function isProjectsPath(relPath) {
    return normalize(relPath).split('/').includes('.projects')
}

// A path inside the public notes, or one of the folders that lead to them (`.projects/`, `.projects/cuttlely/`).
function isPublicNotesPath(rel) {
    const dir = rel.endsWith('/') ? rel : `${rel}/`
    if (PUBLIC_NOTES.startsWith(dir)) return rel.startsWith('.projects')
    if (!rel.startsWith(PUBLIC_NOTES)) return false
    return !PRIVATE_NOTES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))
}

export function violationFor(relPath) {
    const rel = normalize(relPath)
    if (isProjectsPath(rel) && !isPublicNotesPath(rel)) {
        return rel.startsWith(PUBLIC_NOTES)
            ? 'private records under .projects/cuttlely/'
            : 'path under .projects/ outside .projects/cuttlely/'
    }
    const file = rel.replace(/\/$/, '')
    if (EXCLUDED_FILES.includes(file)) return 'file kept out of exports'
    if (EXCLUDED_PATTERNS.some((re) => re.test(file))) return 'file kept out of exports'
    return ''
}

function walk(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        const rel = path.relative(base, full)
        out.push(rel + (entry.isDirectory() ? '/' : ''))
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, base, out)
    }
    return out
}

export function checkExport(files) {
    const violations = []
    for (const rel of files) {
        const reason = violationFor(rel)
        if (reason) violations.push({ path: normalize(rel), reason })
    }
    return violations
}

function main(argv) {
    const json = argv.includes('--json')
    const args = argv.filter((a) => a !== '--json')
    let root
    let files
    if (args[0] === '--files' && args[1]) {
        const rootIdx = args.indexOf('--root')
        root = path.resolve(rootIdx > -1 && args[rootIdx + 1] ? args[rootIdx + 1] : '.')
        const list = args[1] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args[1], 'utf8')
        files = list
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
    } else if (args.length === 1 && !args[0].startsWith('--')) {
        root = path.resolve(args[0])
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            console.error(`check-clean-export: not a directory: ${args[0]}`)
            return 2
        }
        files = walk(root)
    } else {
        console.error('usage: check-clean-export.mjs <export-dir> | --files <list-file|-> [--root <dir>] [--json]')
        return 2
    }
    const violations = checkExport(files)
    if (json) {
        console.log(JSON.stringify({ ok: violations.length === 0, checked: files.length, violations }))
    } else if (violations.length) {
        for (const v of violations) console.error(`check-clean-export: ${v.path}: ${v.reason}`)
        console.error(`check-clean-export: FAILED with ${violations.length} violation(s) in ${files.length} paths`)
    } else {
        console.log(`check-clean-export: OK (${files.length} paths checked)`)
    }
    return violations.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
    process.exitCode = main(process.argv.slice(2))
}
