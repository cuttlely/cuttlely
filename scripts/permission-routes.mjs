// Routes named in the roles guide, checked against the permission each server route declares.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentedPermissionKeys } from './permission-keys.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GUIDE = path.join(ROOT, 'docs', 'how-to', 'roles-and-permissions.md')
const KEY = /[A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const IDENTITY_ROUTER_FILE = {
    identityAuthRouter: 'packages/server/src/identity/http.ts',
    identityAccountRouter: 'packages/server/src/identity/http.ts',
    identityRoleRouter: 'packages/server/src/identity/directoryRoutes.ts',
    identityOrgUserRouter: 'packages/server/src/identity/directoryRoutes.ts',
    identityWorkspaceRouter: 'packages/server/src/identity/directoryRoutes.ts',
    identityWorkspaceUserRouter: 'packages/server/src/identity/directoryRoutes.ts',
    identityUserRouter: 'packages/server/src/identity/directoryRoutes.ts',
    identityUsersRouter: 'packages/server/src/identity/directoryRoutes.ts'
}

function keysIn(value) {
    return [...String(value).matchAll(KEY)].map((match) => match[0]).filter((key) => !key.startsWith('feat:'))
}

function callBody(source, start) {
    let i = start
    let depth = 1
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
                else i += 1
            }
            i += 1
            continue
        }
        if (c === '(') depth += 1
        else if (c === ')') depth -= 1
        if (depth > 0) i += 1
        else i += 1
    }
    return source.slice(start, i - 1)
}

function helperKeys(source) {
    const map = new Map()
    const constRe = /const\s+([A-Za-z0-9_]+)\s*=\s*require(?:Any)?Permission\s*\(/g
    let match
    while ((match = constRe.exec(source))) {
        const body = callBody(source, match.index + match[0].length)
        map.set(match[1], keysIn(body))
    }
    const fnRe = /function\s+([A-Za-z0-9_]+)\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/g
    while ((match = fnRe.exec(source))) {
        let i = match.index + match[0].length - 1
        let depth = 0
        const start = i
        while (i < source.length) {
            if (source[i] === '{') depth += 1
            else if (source[i] === '}') {
                depth -= 1
                if (depth === 0) {
                    i += 1
                    break
                }
            }
            i += 1
        }
        const keys = keysIn(source.slice(start, i))
        if (keys.length) map.set(match[1], keys)
    }
    return map
}

function routePaths(body) {
    const trimmed = body.trim()
    if (trimmed.startsWith('[')) {
        const end = trimmed.indexOf(']')
        return [...trimmed.slice(1, end).matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1])
    }
    const quoted = trimmed.match(/^['"]([^'"]+)['"]/)
    return quoted ? [quoted[1]] : []
}

function joinMount(mount, routePath) {
    const left = `/api/v1${mount.startsWith('/') ? mount : `/${mount}`}`.replace(/\/+$/, '')
    if (!routePath || routePath === '/') return left
    const right = routePath.startsWith('/') ? routePath : `/${routePath}`
    return `${left}${right}`.replace(/\/+/g, '/')
}

function routesInFile(source, mountFor) {
    const helpers = helperKeys(source)
    const ownerGate = /router\.use\(\s*requireOwner\(\s*\)\s*\)/.test(source)
    const found = []
    const re = /\b([A-Za-z0-9_]+)\.(get|post|put|patch|delete)\s*\(/g
    let match
    while ((match = re.exec(source))) {
        const owner = match[1]
        const method = match[2].toUpperCase()
        const mount = mountFor(owner)
        if (!mount) continue
        const body = callBody(source, match.index + match[0].length)
        const paths = routePaths(body)
        const keys = new Set(keysIn(body))
        if (/\brequireOwner\s*\(/.test(body) || ownerGate) keys.add('server:owner')
        for (const [name, extra] of helpers) {
            if (new RegExp(`\\b${name}\\b`).test(body)) {
                for (const key of extra) keys.add(key)
            }
        }
        for (const routePath of paths) {
            found.push({ method, path: joinMount(mount, routePath).replace(/\/+$/, '') || joinMount(mount, routePath), keys: [...keys] })
        }
    }
    return found
}

function mounts(root) {
    const indexPath = path.join(root, 'packages/server/src/routes/index.ts')
    const source = fs.readFileSync(indexPath, 'utf8')
    const files = new Map()
    for (const match of source.matchAll(/import\s+(\w+)\s+from\s+'\.\/([^']+)'/g)) {
        files.set(match[1], path.join(root, 'packages/server/src/routes', match[2], 'index.ts'))
    }
    const mountByFile = new Map()
    const mountByRouter = new Map()
    const useRe = /router\.use\(\s*'([^']+)'\s*,/g
    let useMatch
    while ((useMatch = useRe.exec(source))) {
        const mount = useMatch[1]
        const body = callBody(source, useMatch.index + useMatch[0].length)
        const names = [...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((item) => item[1])
        const routerName = [...names].reverse().find((name) => files.has(name) || IDENTITY_ROUTER_FILE[name])
        if (!routerName) continue
        mountByRouter.set(routerName, mount)
        if (files.has(routerName)) {
            const list = mountByFile.get(files.get(routerName)) || []
            list.push(mount)
            mountByFile.set(files.get(routerName), list)
        }
    }
    return { mountByFile, mountByRouter }
}

export function serverRouteChecks(root = ROOT) {
    const { mountByFile, mountByRouter } = mounts(root)
    const declared = []
    for (const [file, mountList] of mountByFile) {
        if (!fs.existsSync(file)) continue
        const source = fs.readFileSync(file, 'utf8')
        const mount = mountList[0]
        declared.push(...routesInFile(source, (owner) => (owner === 'router' ? mount : null)))
    }
    const identityFiles = new Map()
    for (const [routerName, rel] of Object.entries(IDENTITY_ROUTER_FILE)) {
        const file = path.join(root, rel)
        const routers = identityFiles.get(file) || []
        routers.push(routerName)
        identityFiles.set(file, routers)
    }
    for (const [file, routers] of identityFiles) {
        const source = fs.readFileSync(file, 'utf8')
        declared.push(
            ...routesInFile(source, (owner) => {
                if (routers.includes(owner)) return mountByRouter.get(owner) || null
                if (owner === 'router' && file.endsWith('directoryRoutes.ts')) return mountByRouter.get('identityAccountRouter') || null
                return null
            })
        )
    }
    return declared
}

function permissionSection(markdown) {
    const parts = String(markdown).split(/^## Permission keys\s*$/m)
    if (parts.length < 2) return ''
    return parts[1].split(/^## /m)[0]
}

export function documentedRouteChecks(markdown) {
    const checks = []
    for (const line of permissionSection(markdown).split('\n')) {
        if (!line.startsWith('|')) continue
        const cells = line.split('|')
        const keyCell = cells[1] || ''
        const apiCell = cells[4] || ''
        const keyMatch = keyCell.match(/`([A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9-]+)`/)
        if (!keyMatch) continue
        const key = keyMatch[1]
        const tokens = [...apiCell.matchAll(/`([^`]+)`/g)].map((item) => item[1].trim())
        let pending = []
        const routes = []
        const remember = (method, routePath) => {
            routes.push({ method, path: routePath })
        }
        const hasPath = (token) => /^(GET|POST|PUT|PATCH|DELETE)\s+\/api\/v1\/\S+$/.test(token)
        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index]
            const withPath = token.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/v1\/\S+)$/)
            if (withPath) {
                const routePath = withPath[2].replace(/[.,;]+$/, '')
                const methods = [...new Set([...pending, withPath[1]])]
                pending = []
                for (const method of methods) remember(method, routePath)
                continue
            }
            if (METHODS.has(token)) {
                const upcoming = tokens.slice(index + 1).find((item) => hasPath(item) || item.startsWith('/api/v1/'))
                // `GET`, `DELETE /path` share that path. A bare method with no later path stays on the previous route.
                if (upcoming) pending.push(token)
                else if (routes.length) remember(token, routes[routes.length - 1].path)
                continue
            }
            const pathOnly = token.match(/^(\/api\/v1\/\S+)$/)
            if (!pathOnly) continue
            const routePath = pathOnly[1].replace(/[.,;]+$/, '')
            if (pending.length) {
                for (const method of pending) remember(method, routePath)
                pending = []
            } else {
                remember('', routePath)
            }
        }
        for (const route of routes) checks.push({ key, ...route })
    }
    return checks
}

function segments(routePath) {
    return routePath
        .replace(/\/+$/, '')
        .split('/')
        .filter(Boolean)
        .slice(2)
        .map((part) => (part.startsWith(':') ? ':' : part))
}

function samePattern(left, right) {
    return left.length === right.length && left.every((part, index) => part === right[index])
}

function startsWithPattern(server, guide) {
    if (guide.length > server.length) return false
    return guide.every((part, index) => part === server[index])
}

export function routeCheckMismatches(documented, declared) {
    const problems = []
    for (const item of documented) {
        const guidePat = segments(item.path)
        const matches = declared.filter((route) => {
            if (item.method && route.method !== item.method) return false
            const serverPat = segments(route.path)
            if (item.method) return samePattern(guidePat, serverPat)
            return samePattern(guidePat, serverPat) || startsWithPattern(serverPat, guidePat)
        })
        const label = `${item.method || 'ANY'} ${item.path}`
        if (!matches.length) {
            problems.push(`${item.key}: ${label} is not a declared server route`)
            continue
        }
        if (!matches.some((route) => route.keys.includes(item.key))) {
            const found = [...new Set(matches.flatMap((route) => route.keys))].sort()
            problems.push(`${item.key}: ${label} checks ${found.join(', ') || 'no permission key'}`)
        }
    }
    return problems
}

export function readGuideRouteMismatches(guidePath = GUIDE, root = ROOT) {
    const markdown = fs.readFileSync(guidePath, 'utf8')
    const documented = documentedRouteChecks(markdown)
    if (!documented.length) return ['the permission table names no API routes']
    // Touch the key parser so a table that lost its key column fails here too.
    if (!documentedPermissionKeys(markdown).length) return ['the permission table names no keys']
    return routeCheckMismatches(documented, serverRouteChecks(root))
}
