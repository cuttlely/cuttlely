// Helpers for script tests that build throwaway git repositories.
// A git hook (pre-push) exports GIT_DIR, GIT_PREFIX and friends. A child git that inherits them
// works on the real repository instead of the temp one, so every test git call strips all GIT_*
// variables, runs with -C and cwd set to its own temp folder, and refuses to touch the real repo.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// A copy of env with every GIT_* variable removed.
export function withoutGitEnv(env = process.env) {
    const out = {}
    for (const [k, v] of Object.entries(env)) if (!/^GIT_/.test(k)) out[k] = v
    return out
}

// Remove GIT_* from this test process so code under test that spawns git inherits a clean env.
export function isolateProcessEnv() {
    for (const k of Object.keys(process.env)) if (/^GIT_/.test(k)) delete process.env[k]
}

function real(p) {
    try {
        return fs.realpathSync(p)
    } catch {
        return path.resolve(p)
    }
}

// Throws unless dir is inside the given temp root and git there does not resolve to the real repo.
export function assertIsolated(dir, tmpRoot) {
    const d = real(dir)
    if (tmpRoot && !(d === real(tmpRoot) || d.startsWith(real(tmpRoot) + path.sep))) {
        throw new Error(`refusing to run git outside the test temp folder: ${dir}`)
    }
    const res = spawnSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { cwd: d, encoding: 'utf8', env: withoutGitEnv() })
    const top = res.status === 0 ? real(res.stdout.trim()) : ''
    if (top && top === real(REAL_ROOT)) throw new Error(`refusing to run: ${dir} resolves to the real repository ${REAL_ROOT}`)
}

// git -C dir ...args with a GIT_*-free env. extraEnv is added after stripping.
export function testGit(dir, args, { tmpRoot, extraEnv = {}, prefix = [] } = {}) {
    assertIsolated(dir, tmpRoot)
    const res = spawnSync('git', [...prefix, '-C', dir, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...withoutGitEnv(), ...extraEnv }
    })
    return res
}
