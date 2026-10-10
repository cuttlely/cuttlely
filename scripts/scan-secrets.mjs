// Scan staged and tracked files for secret-shaped text.
// Vendored hermes/ is skipped. Hits are file:line and a pattern name, never the text.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST = path.join(ROOT, 'scripts', 'secrets.allowlist')
const MAX_BYTES = 5 * 1024 * 1024

const PATTERNS = [
    { name: 'sk', re: /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g },
    { name: 'xai', re: /(?:^|[^A-Za-z0-9])xai-[A-Za-z0-9_-]{8,}/g },
    { name: 'ghp', re: /ghp_[A-Za-z0-9]{16,}/g },
    { name: 'github_pat', re: /github_pat_[A-Za-z0-9_]{16,}/g },
    { name: 'akia', re: /AKIA[0-9A-Z]{16}/g },
    { name: 'postgres-url', re: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/gi },
    { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g }
]

function gitLines(args) {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    if (result.status !== 0) return []
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
}

export function trackedAndStagedFiles() {
    const tracked = gitLines(['ls-files'])
    const staged = gitLines(['diff', '--name-only', '--cached'])
    return [...new Set([...tracked, ...staged])]
}

export function loadAllowlist(text) {
    const prefixes = ['hermes/']
    const lines = []
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        if (line.startsWith('prefix ')) {
            prefixes.push(line.slice('prefix '.length).trim())
            continue
        }
        const space = line.indexOf(' ')
        if (space === -1) continue
        lines.push({ path: line.slice(0, space), contains: line.slice(space + 1) })
    }
    return { prefixes, lines }
}

function skipped(file, allow) {
    const path = file.replace(/\\/g, '/')
    // The allowlist names the placeholders on purpose. Scanning it reports those lines.
    if (path === 'scripts/secrets.allowlist') return true
    return allow.prefixes.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))
}

function allowed(file, line, allow) {
    return allow.lines.some((entry) => (entry.path === '*' || entry.path === file) && line.includes(entry.contains))
}

export function scanText(file, text, allow) {
    const hits = []
    const lines = text.split(/\n/)
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (allowed(file, line, allow)) continue
        for (const pattern of PATTERNS) {
            pattern.re.lastIndex = 0
            if (pattern.re.test(line)) hits.push({ file, line: index + 1, pattern: pattern.name })
        }
    }
    return hits
}

function readAllowlist() {
    if (!fs.existsSync(ALLOWLIST)) return loadAllowlist('')
    return loadAllowlist(fs.readFileSync(ALLOWLIST, 'utf8'))
}

function main() {
    const allow = readAllowlist()
    const files = trackedAndStagedFiles().filter((file) => !skipped(file, allow))
    const hits = []
    let skippedLarge = 0
    let skippedBinary = 0
    for (const file of files) {
        const full = path.join(ROOT, file)
        let stat
        try {
            stat = fs.statSync(full)
        } catch {
            continue
        }
        if (!stat.isFile()) continue
        if (stat.size > MAX_BYTES) {
            skippedLarge += 1
            continue
        }
        const buffer = fs.readFileSync(full)
        if (buffer.includes(0)) {
            skippedBinary += 1
            continue
        }
        hits.push(...scanText(file, buffer.toString('utf8'), allow))
    }
    console.log(`secret scan: ${files.length} tracked/staged files, ${hits.length} hit(s)`)
    if (skippedLarge || skippedBinary) {
        console.log(`skipped ${skippedLarge} file(s) over ${MAX_BYTES} bytes and ${skippedBinary} binary file(s)`)
    }
    if (!hits.length) {
        console.log('No secret-shaped text in tracked or staged files.')
        process.exit(0)
    }
    console.error('Secret-shaped text found. The match is not printed.')
    for (const hit of hits) console.error(`${hit.file}:${hit.line} ${hit.pattern}`)
    console.error('Known test placeholders belong in scripts/secrets.allowlist. Do not allowlist a real key.')
    process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
