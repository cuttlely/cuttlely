// Permission keys defined in the server and the UI.
// The roles guide's table is checked against this list.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GUIDE = path.join(ROOT, 'docs', 'how-to', 'roles-and-permissions.md')

const KEY = /^[A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
const SOURCE_ROOTS = [path.join(ROOT, 'packages', 'server', 'src'), path.join(ROOT, 'packages', 'ui', 'src')]
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function walk(dir, out) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === 'migrations') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            walk(full, out)
            continue
        }
        if (!SOURCE_EXT.has(path.extname(entry.name))) continue
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue
        out.push(full)
    }
}

function keysInText(value) {
    const keys = []
    const re = /[A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g
    for (const match of String(value).matchAll(re)) {
        const key = match[0]
        if (!KEY.test(key) || key.startsWith('feat:')) continue
        keys.push(key)
    }
    return keys
}

function addKeys(set, value) {
    for (const key of keysInText(value)) set.add(key)
}

// Balanced call body. Strings are skipped so a quote cannot close the call.
function callBodies(source, names) {
    const bodies = []
    const re = new RegExp(`\\b(?:${names.join('|')})\\s*\\(`, 'g')
    let match
    while ((match = re.exec(source))) {
        let i = match.index + match[0].length
        let depth = 1
        const start = i
        while (i < source.length && depth > 0) {
            const c = source[i]
            const next = source[i + 1]
            if (c === '/' && next === '/') {
                i += 2
                while (i < source.length && source[i] !== '\n') i += 1
                continue
            }
            if (c === '/' && next === '*') {
                i += 2
                while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
                i += 2
                continue
            }
            if (c === "'" || c === '"' || c === '`') {
                const quote = c
                i += 1
                while (i < source.length && source[i] !== quote) {
                    if (source[i] === '\\') i += 2
                    else if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
                        i += 2
                        let inner = 1
                        while (i < source.length && inner > 0) {
                            if (source[i] === '{') inner += 1
                            else if (source[i] === '}') inner -= 1
                            i += 1
                        }
                    } else i += 1
                }
                i += 1
                continue
            }
            if (c === '(') depth += 1
            else if (c === ')') depth -= 1
            i += 1
        }
        bodies.push(source.slice(start, i - 1))
    }
    return bodies
}

function propValues(source) {
    const values = []
    const re = /\b(?:permissionId|permissions|permission)\s*[:=]\s*/g
    let match
    while ((match = re.exec(source))) {
        let i = match.index + match[0].length
        while (i < source.length && /\s/.test(source[i])) i += 1
        const start = i
        const opener = source[i]
        if (opener === '{' || opener === '[') {
            const closer = opener === '{' ? '}' : ']'
            let depth = 0
            while (i < source.length) {
                const c = source[i]
                if (c === "'" || c === '"' || c === '`') {
                    i += 1
                    while (i < source.length && source[i] !== c) {
                        if (source[i] === '\\') i += 2
                        else i += 1
                    }
                    i += 1
                    continue
                }
                if (c === opener) depth += 1
                else if (c === closer) {
                    depth -= 1
                    if (depth === 0) {
                        i += 1
                        break
                    }
                }
                i += 1
            }
            values.push(source.slice(start, i))
            re.lastIndex = i
            continue
        }
        if (opener === "'" || opener === '"' || opener === '`') {
            i += 1
            while (i < source.length && source[i] !== opener) {
                if (source[i] === '\\') i += 2
                else i += 1
            }
            values.push(source.slice(start, i + 1))
        }
    }
    return values
}

// `agentflows:${action}` where action is typed as 'view' | 'update'.
function expandTemplates(source) {
    const keys = []
    const re = /`([A-Za-z][A-Za-z0-9]*):\$\{([A-Za-z_][A-Za-z0-9_]*)\}`/g
    let match
    while ((match = re.exec(source))) {
        const [, prefix, name] = match
        const union = new RegExp(name + "\\s*[:=]\\s*(?:'[^']+'\\s*\\|\\s*)*'[^']+'")
        const found = source.match(union)
        if (!found) continue
        for (const action of found[0].match(/'([^']+)'/g) || []) {
            const key = `${prefix}:${action.slice(1, -1)}`
            if (KEY.test(key)) keys.push(key)
        }
    }
    return keys
}

function catalogKeysFrom(source, rel) {
    const keys = []
    if (rel.endsWith('database/identitySchema.ts')) {
        const stored = source.match(/PERSONAL_WORKSPACE_PERMISSIONS\s*=\s*'([^']*)'/)
        if (stored) keys.push(...keysInText(stored[1].replace(/\\"/g, '"')))
    }
    if (rel.endsWith('identity/permissionsCatalog.ts')) {
        for (const block of source.matchAll(/(?:ADMIN_KEYS|DROPPED_KEYS)[\s\S]*?\[[\s\S]*?\]|new Set\(\[[\s\S]*?\]\)/g)) {
            keys.push(...keysInText(block[0]))
        }
    }
    // API-key feature map. A full key added here is part of the list. Prefixes such as logs: are not keys.
    if (rel.endsWith('services/apikey/index.ts')) {
        const map = source.match(/featureToPermissionMap[\s\S]*?\n        \}/)
        if (map) keys.push(...keysInText(map[0]))
    }
    return keys
}

export function permissionKeys(root = ROOT) {
    const files = []
    const roots = root === ROOT ? SOURCE_ROOTS : SOURCE_ROOTS.map((item) => path.join(root, path.relative(ROOT, item)))
    for (const dir of roots) walk(dir, files)
    const keys = new Set()
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8')
        const rel = path.relative(root, file).replace(/\\/g, '/')
        for (const key of catalogKeysFrom(source, rel)) keys.add(key)
        for (const key of expandTemplates(source)) keys.add(key)
        const includeBodies = []
        const includeRe = /\bpermissions(?:Ids)?\.includes\s*\(/g
        let includeMatch
        while ((includeMatch = includeRe.exec(source))) {
            includeBodies.push(callBodies(source.slice(includeMatch.index), ['includes'])[0] || '')
        }
        const regions = [
            ...callBodies(source, ['requirePermission', 'requireAnyPermission', 'hasAnyPermission', 'hasPermission']),
            ...propValues(source),
            ...includeBodies
        ]
        for (const region of regions) addKeys(keys, region)
    }
    return [...keys].sort()
}

export function documentedPermissionKeys(markdown) {
    const parts = String(markdown).split(/^## Permission keys\s*$/m)
    if (parts.length < 2) return []
    const section = parts[1].split(/^## /m)[0]
    const keys = []
    for (const line of section.split('\n')) {
        if (!line.startsWith('|')) continue
        const cell = line.split('|')[1] || ''
        if (!cell.includes('`')) continue
        const match = cell.match(/`([A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9-]+)`/)
        if (match) keys.push(match[1])
    }
    return keys
}

export function permissionKeyDiff(codeKeys, docKeys) {
    const code = new Set(codeKeys)
    const doc = new Set(docKeys)
    return {
        missingFromDoc: [...code].filter((key) => !doc.has(key)).sort(),
        missingFromCode: [...doc].filter((key) => !code.has(key)).sort(),
        duplicateDocKeys: docKeys.filter((key, index) => docKeys.indexOf(key) !== index).sort()
    }
}

export function readGuideKeys(guidePath = GUIDE) {
    return documentedPermissionKeys(fs.readFileSync(guidePath, 'utf8'))
}

// The role dialog does not offer these. The UI or a route still checks them, and the guide names each one.
const CHECKED_OUTSIDE_CATALOG = [
    'credentials:share',
    'templates:custom-share',
    'workspace:export',
    'workspace:import',
    'sso:manage',
    'executions:update',
    'server:owner'
]

function quotedList(source, constName) {
    const match = source.match(new RegExp(`(?:const|let)\\s+${constName}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`))
    if (!match) return []
    return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
}

export function grantableCatalogKeys(root = ROOT) {
    const schema = fs.readFileSync(path.join(root, 'packages/server/src/database/identitySchema.ts'), 'utf8')
    const catalog = fs.readFileSync(path.join(root, 'packages/server/src/identity/permissionsCatalog.ts'), 'utf8')
    const stored = schema.match(/PERSONAL_WORKSPACE_PERMISSIONS\s*=\s*'([^']*)'/)
    const fromStore = stored ? keysInText(stored[1].replace(/\\"/g, '"')) : []
    const dropped = new Set(quotedList(catalog, 'DROPPED_KEYS'))
    const droppedPrefixes = new Set(quotedList(catalog, 'DROPPED_PREFIXES'))
    const allowed = new Set(quotedList(catalog, 'ALLOWED_PREFIXES'))
    const keys = [...fromStore, ...quotedList(catalog, 'ADMIN_KEYS'), ...quotedList(catalog, 'LOG_KEYS')]
    return [
        ...new Set(
            keys.filter((key) => {
                const prefix = key.split(':')[0] || ''
                if (dropped.has(key) || droppedPrefixes.has(prefix)) return false
                return allowed.has(prefix)
            })
        )
    ].sort()
}

export function permissionPrefixes(root = ROOT) {
    const catalog = fs.readFileSync(path.join(root, 'packages/server/src/identity/permissionsCatalog.ts'), 'utf8')
    return new Set([...quotedList(catalog, 'ALLOWED_PREFIXES'), ...quotedList(catalog, 'DROPPED_PREFIXES')])
}

function permissionRegions(source) {
    const includeBodies = []
    const includeRe = /\bpermissions(?:Ids)?\.includes\s*\(/g
    let includeMatch
    while ((includeMatch = includeRe.exec(source))) {
        includeBodies.push(callBodies(source.slice(includeMatch.index), ['includes'])[0] || '')
    }
    return [
        ...callBodies(source, ['requirePermission', 'requireAnyPermission', 'hasAnyPermission', 'hasPermission']),
        ...propValues(source),
        ...includeBodies
    ]
}

function quotedTokens(region) {
    const tokens = []
    const re = /['"`]([^'"`]*)['"`]/g
    for (const match of String(region).matchAll(re)) {
        for (const part of match[1].split(',')) {
            const token = part.trim()
            if (token && !token.includes('${')) tokens.push(token)
        }
    }
    return tokens
}

function dottedPermissionTokens(source, prefixes) {
    const found = []
    for (const token of quotedTokens(source)) {
        const match = token.match(/^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$/)
        if (match && prefixes.has(match[1])) found.push(token)
    }
    return found
}

export function permissionLiteralProblems(source, { catalog, outside, prefixes }) {
    const catalogSet = catalog instanceof Set ? catalog : new Set(catalog)
    const outsideSet = outside instanceof Set ? outside : new Set(outside || [])
    const prefixSet = prefixes instanceof Set ? prefixes : new Set(prefixes || [])
    const problems = []
    const seen = new Set()
    const consider = (token) => {
        if (!token || seen.has(token)) return
        seen.add(token)
        const dotted = token.match(/^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$/)
        if (dotted && prefixSet.has(dotted[1])) {
            problems.push(`${token} uses a dot; permission keys use a colon`)
            return
        }
        if (!KEY.test(token) || token.startsWith('feat:')) return
        if (catalogSet.has(token) || outsideSet.has(token)) return
        problems.push(`${token} is not in the permission catalog`)
    }
    for (const region of permissionRegions(source)) {
        for (const token of quotedTokens(region)) consider(token)
    }
    for (const token of dottedPermissionTokens(source, prefixSet)) consider(token)
    return problems
}

export function readPermissionLiteralProblems(root = ROOT) {
    const catalog = new Set(grantableCatalogKeys(root))
    const outside = new Set(CHECKED_OUTSIDE_CATALOG)
    const prefixes = permissionPrefixes(root)
    const files = []
    const roots = root === ROOT ? SOURCE_ROOTS : SOURCE_ROOTS.map((item) => path.join(root, path.relative(ROOT, item)))
    for (const dir of roots) walk(dir, files)
    const problems = []
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8')
        const rel = path.relative(root, file).replace(/\\/g, '/')
        for (const problem of permissionLiteralProblems(source, { catalog, outside, prefixes })) {
            problems.push(`${rel}: ${problem}`)
        }
    }
    return problems
}

function main() {
    const keys = permissionKeys()
    if (process.argv.includes('--json')) {
        process.stdout.write(JSON.stringify(keys, null, 2) + '\n')
        return
    }
    for (const key of keys) console.log(key)
    console.error(`${keys.length} permission keys`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
