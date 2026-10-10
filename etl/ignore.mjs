import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_IGNORES = [
    '.git/',
    '.hg/',
    '.svn/',
    'node_modules/',
    '.venv/',
    'venv/',
    '__pycache__/',
    '.pytest_cache/',
    '.mypy_cache/',
    'dist/',
    'build/',
    'out/',
    'target/',
    '.next/',
    '.turbo/',
    '.cache/',
    'coverage/',
    '.cuttlely/',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    '*.lock',
    '*.min.js',
    '*.min.css',
    '*.map',
    '*.{png,jpg,jpeg,gif,webp,bmp,ico,tif,tiff,psd}',
    '*.{pdf,zip,gz,tgz,bz2,xz,7z,rar,jar,war,whl,egg}',
    '*.{class,so,dylib,dll,exe,bin,o,a,obj,lib,pyc,pyo,wasm}',
    '*.{woff,woff2,ttf,otf,eot}',
    '*.{mp3,mp4,mov,avi,mkv,wav,flac,ogg,webm}',
    '*.{sqlite,sqlite3,db,parquet,feather,arrow,npy,npz,pkl,onnx,pt,safetensors}'
]

function escapeChar(c) {
    return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

export function globToRegexSource(glob) {
    let re = ''
    for (let i = 0; i < glob.length; i += 1) {
        const c = glob[i]
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?'
                    i += 2
                } else {
                    re += '.*'
                    i += 1
                }
            } else re += '[^/]*'
        } else if (c === '?') re += '[^/]'
        else if (c === '[') {
            const close = glob.indexOf(']', i + 1)
            if (close > i + 1) {
                let cls = glob.slice(i + 1, close)
                if (cls[0] === '!') cls = `^${cls.slice(1)}`
                re += `[${cls.replace(/\\/g, '\\\\')}]`
                i = close
            } else re += '\\['
        } else if (c === '{') {
            const close = glob.indexOf('}', i + 1)
            if (close > i) {
                re += `(?:${glob
                    .slice(i + 1, close)
                    .split(',')
                    .map((part) => globToRegexSource(part))
                    .join('|')})`
                i = close
            } else re += '\\{'
        } else if (c === '\\' && i + 1 < glob.length) {
            i += 1
            re += escapeChar(glob[i])
        } else re += escapeChar(c)
    }
    return re
}

export function compileRule(line) {
    let text = String(line || '').replace(/(?<!\\)\s+$/, '')
    if (!text || text.startsWith('#')) return null
    let negate = false
    if (text.startsWith('!')) {
        negate = true
        text = text.slice(1)
    }
    if (text.startsWith('\\#') || text.startsWith('\\!')) text = text.slice(1)
    let dirOnly = false
    if (text.endsWith('/')) {
        dirOnly = true
        text = text.slice(0, -1)
    }
    if (!text) return null
    const anchored = text.includes('/')
    if (text.startsWith('/')) text = text.slice(1)
    const source = `^${anchored ? '' : '(?:.*/)?'}${globToRegexSource(text)}(?:/.*)?$`
    return { regex: new RegExp(source), negate, dirOnly }
}

export function compileRules(lines, base = '') {
    return { base, rules: lines.map(compileRule).filter(Boolean) }
}

// Rule sets are ordered from the walk root down; within and across sets the last matching rule wins, as in git.
export function isIgnored(relPath, isDir, ruleSets) {
    let ignored = false
    for (const set of ruleSets) {
        let rel = relPath
        if (set.base) {
            if (!relPath.startsWith(`${set.base}/`)) continue
            rel = relPath.slice(set.base.length + 1)
        }
        for (const rule of set.rules) {
            if (rule.dirOnly && !isDir) continue
            if (rule.regex.test(rel)) ignored = !rule.negate
        }
    }
    return ignored
}

export function splitList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
    return String(value || '')
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
}

export function compareSegments(a, b) {
    const left = a.split('/')
    const right = b.split('/')
    const n = Math.min(left.length, right.length)
    for (let i = 0; i < n; i += 1) {
        if (left[i] < right[i]) return -1
        if (left[i] > right[i]) return 1
    }
    return left.length - right.length
}

// Depth-first over sorted entries, recursing into a directory where it sorts, so files come out in
// compareSegments order and a resumed walk can skip everything up to the checkpoint path.
export function* walkFiles(root, { respectGitignore = true, useDefaults = true, exclude = [], include = [] } = {}) {
    const baseRules = []
    if (useDefaults) baseRules.push(compileRules(DEFAULT_IGNORES))
    if (exclude.length) baseRules.push(compileRules(exclude))
    const includeRules = include.length ? compileRules(include) : null
    yield* walkDir(root, '', baseRules, { respectGitignore, includeRules })
}

function* walkDir(dir, rel, ruleSets, options) {
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return
    }
    let sets = ruleSets
    if (options.respectGitignore && entries.some((entry) => entry.isFile() && entry.name === '.gitignore')) {
        sets = [...ruleSets, compileRules(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split(/\r?\n/), rel)]
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (!isIgnored(childRel, true, sets)) yield* walkDir(full, childRel, sets, options)
            continue
        }
        if (!entry.isFile() || isIgnored(childRel, false, sets)) continue
        if (options.includeRules && !isIgnored(childRel, false, [options.includeRules])) continue
        let stat
        try {
            stat = fs.statSync(full)
        } catch {
            continue
        }
        yield { abs: full, rel: childRel, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) }
    }
}
