// Classify a push against origin/main. When .projects/cuttlely/ exists, a code
// change must also touch it. Docs-only and tests-only diffs do not.
// When that directory is absent, the check skips. The notes are local.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HANDOFF_PREFIX = '.projects/cuttlely/'

export function handoffDirectoryExists(root = process.cwd()) {
    try {
        return fs.statSync(path.join(root, '.projects', 'cuttlely')).isDirectory()
    } catch {
        return false
    }
}

export function handoffSkipMessage() {
    return [
        'Handoff check skipped: .projects/cuttlely/ is not in this checkout.',
        'Those notes are optional and are not part of the public tree.',
        'When the directory is present, a code change must update it.'
    ].join('\n')
}

const DOC_EXT = /\.(md|markdown)$/i
const TEST_FILE = /\.(test|spec)\.(cjs|mjs|js|jsx|ts|tsx)$/

export function normalizeRepoPath(file) {
    return String(file || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
}

export function isDocPath(file) {
    const path = normalizeRepoPath(file)
    return DOC_EXT.test(path) || path.startsWith('.projects/')
}

export function isTestPath(file) {
    const path = normalizeRepoPath(file)
    if (TEST_FILE.test(path)) return true
    if (/(^|\/)__(tests|mocks)__\//.test(path)) return true
    if (/(^|\/)cypress\//.test(path)) return true
    return false
}

export function isHandoffPath(file) {
    return normalizeRepoPath(file).startsWith(HANDOFF_PREFIX)
}

// code: not a doc and not a test. Handoff files are docs, so they are not code.
export function classifyFiles(files) {
    const code = []
    const docs = []
    const tests = []
    const handoff = []
    const seen = new Set()
    for (const raw of files || []) {
        const path = normalizeRepoPath(raw)
        if (!path || seen.has(path)) continue
        seen.add(path)
        if (isHandoffPath(path)) handoff.push(path)
        if (isDocPath(path)) docs.push(path)
        else if (isTestPath(path)) tests.push(path)
        else code.push(path)
    }
    const ok = code.length === 0 || handoff.length > 0
    return { ok, code, docs, tests, handoff }
}

function git(args) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

export function changedFilesSinceMain(sha) {
    const tip = sha || 'HEAD'
    let mergeBase = ''
    let baseName = ''
    for (const base of ['origin/main', 'main']) {
        const found = git(['merge-base', tip, base])
        if (found.status === 0 && found.stdout.trim()) {
            mergeBase = found.stdout.trim()
            baseName = base
            break
        }
    }
    if (!mergeBase) {
        throw new Error('Could not find a merge-base with origin/main or main. Fetch origin main and run again.')
    }
    const diff = git(['diff', '--name-only', `${mergeBase}..${tip}`])
    if (diff.status !== 0) {
        throw new Error(diff.stderr.trim() || `git diff failed for ${mergeBase}..${tip}`)
    }
    const files = diff.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    return { baseName, mergeBase, tip, files }
}

export function formatBlock(result, files) {
    const lines = []
    if (result.ok) {
        if (!files.length) lines.push('No files changed against main.')
        else if (!result.code.length) lines.push('Docs-only or tests-only change. Handoff files are not required.')
        else lines.push(`Code change also touches ${result.handoff.length} file(s) under ${HANDOFF_PREFIX}.`)
        return lines.join('\n')
    }
    lines.push('This push changes code and does not touch .projects/cuttlely/.')
    lines.push('')
    lines.push('Run the refresh-project-handoff skill and commit the refreshed handoff in this branch before pushing.')
    lines.push('Do that once before the push, not on every commit.')
    lines.push('')
    lines.push('Code files:')
    for (const file of result.code.slice(0, 30)) lines.push(`  ${file}`)
    if (result.code.length > 30) lines.push(`  ... ${result.code.length - 30} more`)
    lines.push('')
    lines.push('Docs-only and tests-only pushes are allowed without that update.')
    lines.push('Bypass (not for a normal code change): CUTTLELY_SKIP_HANDOFF_CHECK=1')
    return lines.join('\n')
}

function shaArg(argv) {
    const index = argv.indexOf('--sha')
    if (index === -1) return ''
    const sha = argv[index + 1]
    if (!sha || sha.startsWith('--')) throw new Error('--sha needs a commit')
    return sha
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
    try {
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
        if (!handoffDirectoryExists(repoRoot)) {
            console.log(handoffSkipMessage())
            process.exit(0)
        }
        const sha = shaArg(process.argv.slice(2))
        const range = changedFilesSinceMain(sha || 'HEAD')
        const result = classifyFiles(range.files)
        console.log(`handoff check ${range.baseName}..${range.tip} (${range.files.length} files)`)
        console.log(formatBlock(result, range.files))
        process.exit(result.ok ? 0 : 1)
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(2)
    }
}
