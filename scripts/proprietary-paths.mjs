// Proprietary path check. The required lint job in .github/workflows/main.yml runs it
// with --base HEAD^1 on a pull request, so the diff is the PR merge commit against its base.
// Without --base it diffs against the merge base with origin/main, plus staged and unstaged files.
// extensions/ is blocked. apps/ is blocked except apps/oss-app/. The commercial identity tree must stay deleted.
// tsc leaves outputs behind after a source file is removed, so IdentityManager
// and StripeManager .js, .d.ts, and .js.map files under the server src or dist
// trees are commercial too. The server build deletes the dist copies.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const COMMERCIAL_TREE = [
    'packages/server/src/enterprise',
    'packages/server/src/IdentityManager.ts',
    'packages/server/src/StripeManager.ts',
    'packages/server/dist/enterprise'
]

// Compiled leftovers of the deleted managers. .d.ts.map is included so a
// declaration map cannot sit next to the .d.ts the build already removes.
const MANAGER_ARTIFACT = /^(?:IdentityManager|StripeManager)\.(?:js|d\.ts)(?:\.map)?$/

function isManagerArtifactPath(normalized) {
    if (!normalized.startsWith('packages/server/src/') && !normalized.startsWith('packages/server/dist/')) return false
    const base = normalized.slice(normalized.lastIndexOf('/') + 1)
    return MANAGER_ARTIFACT.test(base)
}

export function isCommercialPath(file) {
    const normalized = String(file || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
    if (!normalized) return false
    if (normalized === 'packages/server/src/IdentityManager.ts' || normalized.endsWith('/IdentityManager.ts')) return true
    if (normalized === 'packages/server/src/StripeManager.ts' || normalized.endsWith('/StripeManager.ts')) return true
    if (normalized === 'packages/server/src/enterprise' || normalized.startsWith('packages/server/src/enterprise/')) return true
    if (normalized === 'packages/server/dist/enterprise' || normalized.startsWith('packages/server/dist/enterprise/')) return true
    if (isManagerArtifactPath(normalized)) return true
    return false
}

function managerArtifactsOnDisk(root) {
    const found = []
    for (const relRoot of ['packages/server/src', 'packages/server/dist']) {
        walkManagerArtifacts(path.join(root, relRoot), relRoot, found)
    }
    return found
}

function walkManagerArtifacts(abs, rel, found) {
    let entries
    try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules') continue
        const childRel = `${rel}/${entry.name}`
        if (entry.isDirectory()) {
            walkManagerArtifacts(path.join(abs, entry.name), childRel, found)
            continue
        }
        if (MANAGER_ARTIFACT.test(entry.name)) found.push(childRel)
    }
}

export function commercialTreePresent(root = ROOT) {
    const violations = []
    for (const rel of COMMERCIAL_TREE) {
        if (fs.existsSync(path.join(root, rel))) violations.push(rel)
    }
    for (const rel of managerArtifactsOnDisk(root)) {
        if (!violations.includes(rel)) violations.push(rel)
    }
    return violations
}

export function proprietaryViolations(files) {
    const violations = []
    const seen = new Set()
    for (const raw of files || []) {
        const file = String(raw || '')
            .replace(/\\/g, '/')
            .replace(/^\.\//, '')
        if (!file || seen.has(file)) continue
        seen.add(file)
        if (file.startsWith('extensions/')) {
            violations.push(file)
            continue
        }
        if (file.startsWith('apps/') && !file.startsWith('apps/oss-app/')) {
            violations.push(file)
            continue
        }
        if (isCommercialPath(file)) violations.push(file)
    }
    return violations
}

function git(args) {
    return spawnSync('git', args, { encoding: 'utf8' })
}

function mergeBase() {
    for (const base of ['origin/main', 'main']) {
        const found = git(['merge-base', 'HEAD', base])
        if (found.status === 0 && found.stdout.trim()) return { name: base, sha: found.stdout.trim() }
    }
    return null
}

function names(result) {
    if (result.status !== 0) return []
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
}

export function filesToCheck(baseRev = '') {
    let base = null
    if (baseRev) {
        const resolved = git(['rev-parse', '--verify', `${baseRev}^{commit}`])
        if (resolved.status !== 0) throw new Error(`--base ${baseRev} is not a commit in this checkout`)
        base = { name: baseRev, sha: resolved.stdout.trim() }
    } else base = mergeBase()
    const committed = base ? names(git(['diff', '--name-only', `${base.sha}..HEAD`])) : []
    const staged = names(git(['diff', '--name-only', '--cached']))
    const unstaged = names(git(['diff', '--name-only']))
    return { base: base ? base.name : '', files: [...committed, ...staged, ...unstaged] }
}

export function reportedViolations(files, root = ROOT) {
    const fromDiff = []
    for (const file of proprietaryViolations(files)) {
        // A deletion of the commercial tree is the fix. A path counts only when it is still on disk.
        if (isCommercialPath(file) && !fs.existsSync(path.join(root, file))) continue
        fromDiff.push(file)
    }
    const tree = commercialTreePresent(root)
    return [...fromDiff, ...tree.filter((item) => !fromDiff.includes(item))]
}

export function parseBase(argv) {
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--base') {
            const value = argv[i + 1]
            if (!value || value.startsWith('--')) throw new Error('--base needs a commit')
            return value
        }
        if (arg.startsWith('--base=')) return arg.slice('--base='.length)
        throw new Error(`Unknown argument ${arg}`)
    }
    return ''
}

function main() {
    let checked
    try {
        checked = filesToCheck(parseBase(process.argv.slice(2)))
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
    }
    const { base, files } = checked
    const violations = reportedViolations(files)
    console.log(base ? `proprietary paths vs ${base} (${files.length} files)` : `proprietary paths (${files.length} files)`)
    if (!violations.length) {
        console.log('No proprietary paths detected.')
        process.exit(0)
    }
    console.error('Files in proprietary paths detected.')
    console.error(
        'Proprietary paths: extensions/, apps/* except apps/oss-app/, packages/server/src/enterprise/, IdentityManager.ts, StripeManager.ts, and IdentityManager or StripeManager .js, .d.ts, and .js.map files under packages/server/src or packages/server/dist.'
    )
    for (const file of violations) console.error(`  ${file}`)
    process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
