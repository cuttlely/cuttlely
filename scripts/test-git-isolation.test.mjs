// Regression: run the git-using script tests the way a pre-push hook does, with GIT_DIR and friends
// pointing at a throwaway "real" repository, and prove that repository is untouched.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertIsolated, withoutGitEnv } from './test-git.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// node --test marks its children with NODE_TEST_CONTEXT; drop it so the nested run is a real run.
function cleanEnv() {
    const env = withoutGitEnv()
    delete env.NODE_TEST_CONTEXT
    return env
}

function git(dir, ...args) {
    const res = spawnSync('git', ['-C', dir, ...args], { cwd: dir, encoding: 'utf8', env: withoutGitEnv() })
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
}

function snapshot(dir) {
    return {
        head: git(dir, 'rev-parse', 'HEAD'),
        branch: git(dir, 'symbolic-ref', '-q', 'HEAD'),
        refs: git(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
        status: git(dir, 'status', '--porcelain'),
        count: git(dir, 'rev-list', '--all', '--count')
    }
}

function withHookRepo(files, check) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-git-isolation-')))
    try {
        const realRepo = path.join(dir, 'real')
        fs.mkdirSync(realRepo)
        git(realRepo, 'init', '-q', '-b', 'main')
        fs.writeFileSync(path.join(realRepo, 'keep.txt'), 'keep\n')
        git(realRepo, 'add', '.')
        git(realRepo, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'real')
        const before = snapshot(realRepo)
        const res = spawnSync(process.execPath, ['--test', ...files.map((file) => path.join(HERE, file))], {
            cwd: ROOT,
            encoding: 'utf8',
            env: {
                ...cleanEnv(),
                GIT_DIR: path.join(realRepo, '.git'),
                GIT_WORK_TREE: realRepo,
                GIT_INDEX_FILE: path.join(realRepo, '.git', 'index'),
                GIT_OBJECT_DIRECTORY: path.join(realRepo, '.git', 'objects'),
                GIT_PREFIX: ''
            }
        })
        check(res, realRepo, before)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

function assertHookRepoUntouched(res, realRepo, before, minPass) {
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`)
    const passed = Number((/(?:ℹ|#) pass (\d+)/.exec(res.stdout) || [])[1] || 0)
    assert.ok(passed >= minPass, `the nested tests did not run:\n${res.stdout}`)
    assert.deepEqual(snapshot(realRepo), before)
    assert.equal(fs.readFileSync(path.join(realRepo, 'keep.txt'), 'utf8'), 'keep\n')
}

test('the release and vendor tests leave the repository named by GIT_DIR untouched', () => {
    withHookRepo(['release.test.mjs', 'vendor-hermes.test.mjs'], (res, realRepo, before) => {
        assertHookRepoUntouched(res, realRepo, before, 10)
    })
})

test('the boundary fixture git calls leave the repository named by GIT_DIR untouched', () => {
    const cases = fs.readFileSync(path.join(HERE, 'check-boundaries.test.mjs'), 'utf8').match(/^\s*it\(/gm).length
    withHookRepo(['check-boundaries.test.mjs'], (res, realRepo, before) => {
        assertHookRepoUntouched(res, realRepo, before, cases)
    })
})

test('the guard refuses a folder that resolves to the real repository', () => {
    assert.throws(() => assertIsolated(ROOT), /real repository/)
    assert.throws(() => assertIsolated(ROOT, os.tmpdir()), /outside the test temp folder|real repository/)
})

test('the boundary fixture tests leave the repository named by GIT_DIR untouched', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-git-isolation-')))
    try {
        const realRepo = path.join(dir, 'real')
        fs.mkdirSync(realRepo)
        git(realRepo, 'init', '-q', '-b', 'main')
        fs.writeFileSync(path.join(realRepo, 'keep.txt'), 'keep\n')
        git(realRepo, 'add', '.')
        git(realRepo, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'real')
        const before = snapshot(realRepo)

        const res = spawnSync(process.execPath, ['--test', path.join(HERE, 'check-boundaries.test.mjs')], {
            cwd: ROOT,
            encoding: 'utf8',
            env: {
                ...cleanEnv(),
                GIT_DIR: path.join(realRepo, '.git'),
                GIT_WORK_TREE: realRepo,
                GIT_INDEX_FILE: path.join(realRepo, '.git', 'index'),
                GIT_OBJECT_DIRECTORY: path.join(realRepo, '.git', 'objects'),
                GIT_PREFIX: ''
            },
            maxBuffer: 16 * 1024 * 1024
        })
        assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`)
        const passed = Number((/(?:ℹ|#) pass (\d+)/.exec(res.stdout) || [])[1] || 0)
        assert.ok(passed >= 10, `the nested boundary tests did not run:\n${res.stdout}`)
        assert.deepEqual(snapshot(realRepo), before)
        assert.equal(fs.readFileSync(path.join(realRepo, 'keep.txt'), 'utf8'), 'keep\n')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
