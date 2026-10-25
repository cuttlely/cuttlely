// Checks architecture/boundaries.json against the tracked tree.
// A file can match more than one path glob. The most specific glob wins
// (the one with the most literal characters), so a helper under scripts/
// can belong to one subsystem while the rest of scripts/ stays core-shared.
// Two subsystems that tie on that score are an error.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const matchers = new Map()

export function matchGlob(pattern, file) {
    let matcher = matchers.get(pattern)
    if (!matcher) {
        matcher = compileGlob(pattern)
        matchers.set(pattern, matcher)
    }
    return matcher(file)
}

function compileGlob(pattern) {
    if (!pattern.includes('*') && !pattern.includes('?')) return (file) => file === pattern
    if (pattern.endsWith('/**')) {
        const prefix = pattern.slice(0, -3)
        if (!prefix.includes('*') && !prefix.includes('?')) return (file) => file.startsWith(`${prefix}/`)
    }
    if (!pattern.includes('**')) {
        const source = pattern
            .split('/')
            .map((part) =>
                part
                    .split(/([*?])/)
                    .map((token) => {
                        if (token === '*') return '[^/]*'
                        if (token === '?') return '[^/]'
                        return token.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    })
                    .join('')
            )
            .join('/')
        const re = new RegExp(`^${source}$`)
        return (file) => re.test(file)
    }
    return (file) => slowMatch(pattern, file)
}

function slowMatch(pattern, file) {
    const patternSegs = pattern.split('/')
    const fileSegs = file.split('/')
    const rec = (i, j) => {
        if (i === patternSegs.length) return j === fileSegs.length
        const part = patternSegs[i]
        if (part === '**') {
            if (i === patternSegs.length - 1) return j < fileSegs.length
            for (let k = j; k <= fileSegs.length; k++) {
                if (rec(i + 1, k)) return true
            }
            return false
        }
        if (j >= fileSegs.length) return false
        if (matchGlob(part, fileSegs[j])) return rec(i + 1, j + 1)
        return false
    }
    return rec(0, 0)
}

function specificity(pattern) {
    let score = 0
    for (const char of pattern) {
        if (char !== '*' && char !== '?') score++
    }
    return score
}

function matchesAny(globs, file) {
    return globs.some((glob) => matchGlob(glob, file))
}

export function winningSubsystem(file, subsystems) {
    const scored = []
    for (const subsystem of subsystems) {
        let best = -1
        for (const glob of subsystem.paths) {
            if (matchGlob(glob, file)) best = Math.max(best, specificity(glob))
        }
        if (best >= 0) scored.push({ best, name: subsystem.name })
    }
    if (!scored.length) return null
    scored.sort((a, b) => b.best - a.best)
    if (scored.length > 1 && scored[0].best === scored[1].best && scored[0].name !== scored[1].name) {
        return { tie: true, names: [scored[0].name, scored[1].name] }
    }
    return { tie: false, name: scored[0].name }
}

// A hook exports GIT_DIR. Listing files must follow `root`, not that repository.
function gitEnv() {
    const env = {}
    for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/.test(key)) env[key] = value
    return env
}

export function trackedFiles(root = ROOT) {
    const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: root,
        env: gitEnv(),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    })
    return out.split('\0').filter(Boolean)
}

export function loadBoundaryMap(root = ROOT) {
    const file = path.join(root, 'architecture', 'boundaries.json')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function architectureMapErrors(files, map) {
    const errors = []
    const globs = [
        ...map.zones.core.map((glob) => ['zones.core', glob]),
        ...map.zones.inherited.map((glob) => ['zones.inherited', glob]),
        ...map.zones.vendored.map((glob) => ['zones.vendored', glob])
    ]
    for (const subsystem of map.subsystems) {
        for (const glob of subsystem.paths) globs.push([subsystem.name, glob])
        for (const entry of subsystem.entryPoints) {
            if (!files.includes(entry)) errors.push(`entry point is not tracked: ${subsystem.name} ${entry}`)
        }
    }
    for (const [owner, glob] of globs) {
        if (!files.some((file) => matchGlob(glob, file))) errors.push(`glob matches no tracked file: ${owner} ${glob}`)
    }

    for (const file of files) {
        if (matchesAny(map.zones.vendored, file)) {
            const win = winningSubsystem(file, map.subsystems)
            if (!win || win.tie || win.name !== 'Agent runtime') {
                errors.push(`vendored file is not in the agent runtime subsystem: ${file}`)
            }
            if (matchesAny(map.zones.core, file)) errors.push(`vendored file matches a core glob: ${file}`)
            continue
        }
        const win = winningSubsystem(file, map.subsystems)
        if (win?.tie) {
            errors.push(`tie between ${win.names.join(' and ')}: ${file}`)
            continue
        }
        const core = matchesAny(map.zones.core, file)
        if (win) {
            if (win.name === 'Agent runtime') errors.push(`agent runtime subsystem matches a file outside the vendored tree: ${file}`)
            if (!core) errors.push(`subsystem file is not in the core zone: ${win.name} ${file}`)
            continue
        }
        if (core) {
            errors.push(`core file is unassigned: ${file}`)
            continue
        }
        if (!matchesAny(map.zones.inherited, file)) errors.push(`tracked file is in no zone: ${file}`)
    }
    return errors
}

export function checkArchitectureMap(root = ROOT) {
    return architectureMapErrors(trackedFiles(root), loadBoundaryMap(root))
}
