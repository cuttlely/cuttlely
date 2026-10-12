// pnpm hermes:vendor against a made-up upstream repo on disk. No network.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isolateProcessEnv, testGit } from './test-git.mjs'
import {
    abort,
    check,
    excludedBy,
    filesToKeep,
    parseExcludes,
    parseLoaded,
    paths,
    patchMessage,
    resume,
    savePatches,
    vendor
} from './vendor-hermes.mjs'

const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false']
isolateProcessEnv()
const TMP = fs.realpathSync(os.tmpdir())
function git(cwd, ...args) {
    const res = testGit(cwd, args, { tmpRoot: TMP, prefix: ID })
    assert.equal(res.status, 0, res.stderr)
    return res.stdout
}
function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
}
const quiet = () => {}

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-hermes-'))
    const up = path.join(dir, 'upstream')
    write(path.join(up, 'README.md'), 'demo agent\n')
    write(path.join(up, 'agent/core.py'), 'def run():\n    return "core"\n')
    write(path.join(up, 'tool.py'), 'LIMIT = 1\n\ndef tool():\n    return LIMIT\n')
    write(path.join(up, 'tests/test_core.py'), 'def test():\n    pass\n')
    write(path.join(up, 'plugins/demo/tests/test_demo.py'), 'pass\n')
    write(path.join(up, 'website/index.md'), '# site\n')
    write(path.join(up, 'web/dist/app.js'), 'built\n')
    fs.writeFileSync(path.join(up, 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 })
    git(dir, 'init', '-q', '-b', 'main', up)
    git(up, 'add', '-A')
    git(up, 'commit', '-q', '-m', 'v1')
    git(up, 'tag', 'v1')
    const repo = path.join(dir, 'repo')
    write(path.join(repo, '.gitignore'), '**/dist\n')
    write(path.join(repo, 'hermes/CUTTLELY_EXCLUDE.txt'), '# demo\ntests/\n/website/\n')
    write(path.join(repo, 'hermes/CUTTLELY_VENDOR.txt'), 'Vendored for the test.\n')
    git(dir, 'init', '-q', '-b', 'main', repo)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'start')
    git(repo, 'checkout', '-q', '-b', 'work')
    const p = paths(repo, { CUTTLELY_HERMES_UPSTREAM: up, CUTTLELY_HERMES_VENDOR_CACHE: path.join(dir, 'cache') })
    return { dir, up, repo, p }
}
function commitAll(repo, message) {
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
}
const read = (p, file) => fs.readFileSync(path.join(p.hermes, file), 'utf8')
const exists = (p, file) => fs.existsSync(path.join(p.hermes, file))

test('the exclude list matches folders at any depth or at the root, and files at the root', () => {
    const patterns = parseExcludes('# c\n\ntests/\n/website/\n/package-lock.json\n')
    assert.equal(excludedBy('tests/a.py', patterns), 'tests/')
    assert.equal(excludedBy('plugins/x/tests/a.py', patterns), 'tests/')
    assert.equal(excludedBy('tests', patterns), null)
    assert.equal(excludedBy('website/a.md', patterns), '/website/')
    assert.equal(excludedBy('docs/website/a.md', patterns), null)
    assert.equal(excludedBy('package-lock.json', patterns), '/package-lock.json')
    assert.equal(excludedBy('web/package-lock.json', patterns), null)
    assert.throws(() => parseExcludes('a/b/\n'), /unsupported pattern/)
})

test('vendoring drops excluded and ignored files, keeps modes, and writes the lock; the check passes', () => {
    const { repo, p } = setup()
    vendor(p, 'v1', quiet)
    assert.ok(exists(p, 'README.md') && exists(p, 'agent/core.py') && exists(p, 'tool.py'))
    assert.ok(!exists(p, 'tests/test_core.py') && !exists(p, 'plugins/demo/tests/test_demo.py') && !exists(p, 'website/index.md'))
    assert.ok(!exists(p, 'web/dist/app.js'), 'a file .gitignore matches is left out')
    assert.ok(fs.statSync(path.join(p.hermes, 'run.sh')).mode & 0o100)
    const commit = git(path.join(repo, '..', 'upstream'), 'rev-parse', 'v1').trim()
    assert.equal(read(p, 'UPSTREAM_COMMIT').trim(), commit)
    assert.match(read(p, 'CUTTLELY_VENDOR.lock'), new RegExp(`commit: ${commit}`))
    assert.equal(read(p, 'CUTTLELY_VENDOR.txt'), 'Vendored for the test.\n')
    assert.deepEqual(check(p), [])
    commitAll(repo, 'vendor v1')
    vendor(p, 'v1', quiet)
    assert.equal(git(repo, 'status', '--porcelain'), '', 'vendoring the same commit again changes nothing')
})

test('saved patches survive a re-vendor, and the check catches hand edits and returning excluded folders', () => {
    const { repo, p } = setup()
    vendor(p, 'v1', quiet)
    commitAll(repo, 'vendor v1')
    write(path.join(p.hermes, 'tool.py'), 'LIMIT = 5  # cuttlely\n\ndef tool():\n    return LIMIT\n')
    write(path.join(p.hermes, 'tests/test_cuttlely.py'), 'def test_limit():\n    pass\n')
    assert.throws(() => savePatches(p, {}, quiet), /No patch owns tests\/test_cuttlely.py, tool.py/)
    savePatches(p, { name: 'raise the tool limit', message: 'What: LIMIT is 5.\n\nWhy: the demo needs it.' }, quiet)
    const patches = fs.readdirSync(p.patches)
    assert.deepEqual(patches, ['0001-cuttlely-raise-the-tool-limit.patch'])
    const text = fs.readFileSync(path.join(p.patches, patches[0]), 'utf8')
    assert.match(text, /^From 0{40} /)
    assert.deepEqual(patchMessage(text), {
        subject: 'cuttlely: raise the tool limit',
        body: 'What: LIMIT is 5.\n\nWhy: the demo needs it.'
    })
    assert.deepEqual(check(p), [], 'a file a patch adds may sit under an excluded folder')
    commitAll(repo, 'patch')
    vendor(p, 'v1', quiet)
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the patches reproduce the tree')

    write(path.join(p.hermes, 'README.md'), 'edited by hand\n')
    assert.match(check(p).join('\n'), /changed outside pnpm hermes:vendor/)
    fs.rmSync(path.join(p.hermes, 'README.md'))
    assert.match(check(p).join('\n'), /changed outside pnpm hermes:vendor/, 'a deleted file counts as a change')
    git(repo, 'checkout', '--', 'hermes/README.md')
    write(path.join(p.hermes, 'tool.py'), 'LIMIT = 7  # cuttlely\n\ndef tool():\n    return LIMIT\n')
    assert.match(check(p).join('\n'), /0001-cuttlely-raise-the-tool-limit.patch no longer matches/)
    git(repo, 'checkout', '--', 'hermes/tool.py')
    write(path.join(p.hermes, 'website/index.md'), '# back\n')
    assert.match(check(p).join('\n'), /match CUTTLELY_EXCLUDE.txt, for example website\/index.md/)
    fs.rmSync(path.join(p.hermes, 'website'), { recursive: true })
    assert.deepEqual(check(p), [])
})

test('a patch that conflicts on upgrade stops before hermes/ changes, and --abort or --continue finish it', () => {
    const { up, repo, p } = setup()
    vendor(p, 'v1', quiet)
    commitAll(repo, 'vendor v1')
    write(path.join(p.hermes, 'tool.py'), 'LIMIT = 5  # cuttlely\n\ndef tool():\n    return LIMIT\n')
    savePatches(p, { name: 'raise the tool limit', message: 'What: LIMIT is 5.' }, quiet)
    commitAll(repo, 'patch')
    write(path.join(up, 'tool.py'), 'LIMIT = 2\n\ndef tool():\n    return LIMIT\n')
    write(path.join(up, 'agent/new.py'), 'NEW = True\n')
    git(up, 'add', '-A')
    git(up, 'commit', '-q', '-m', 'v2')
    git(up, 'tag', 'v2')

    const before = git(repo, 'rev-parse', 'HEAD:hermes')
    assert.throws(
        () => vendor(p, 'v2', quiet),
        /Stopped: "cuttlely: raise the tool limit" did not apply\. hermes\/ was not changed\.[\s\S]*tool\.py/
    )
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.throws(() => vendor(p, 'v2', quiet), /already in progress/)
    abort(p, quiet)
    assert.ok(!fs.existsSync(p.staging) && !fs.existsSync(p.state))
    assert.equal(git(repo, 'rev-parse', 'HEAD:hermes'), before)

    assert.throws(() => vendor(p, 'v2', quiet), /Stopped/)
    write(path.join(p.staging, 'tool.py'), 'LIMIT = 5  # cuttlely\n\ndef tool():\n    return LIMIT\n')
    git(p.staging, 'add', 'tool.py')
    resume(p, quiet)
    assert.equal(read(p, 'tool.py'), 'LIMIT = 5  # cuttlely\n\ndef tool():\n    return LIMIT\n')
    assert.ok(exists(p, 'agent/new.py'))
    assert.equal(read(p, 'UPSTREAM_COMMIT').trim(), git(up, 'rev-parse', 'v2').trim())
    assert.match(read(p, 'CUTTLELY_VENDOR.lock'), /ref: v2/)
    assert.deepEqual(check(p), [])
})

test('a loaded list keeps measured files plus inits, named data, licenses and patch files', () => {
    assert.deepEqual(parseLoaded('# note\n\ntool.py\n'), ['tool.py'])
    assert.throws(() => parseLoaded('# only a comment\n'), /no paths/)
    assert.throws(() => parseLoaded('../secret\n'), /unsupported path/)
    const readFile = (file) => (file === 'agent/core.py' ? 'open("notes.yaml")\n' : '')
    const keep = filesToKeep(
        ['README.md', 'tool.py', 'extra.py', 'agent/core.py', 'agent/__init__.py', 'agent/notes.yaml', 'LICENSE', 'run.sh'],
        { loaded: ['tool.py', 'agent/core.py'], patchFiles: ['run.sh'], readFile }
    )
    for (const file of ['tool.py', 'agent/core.py', 'agent/__init__.py', 'agent/notes.yaml', 'LICENSE', 'run.sh']) {
        assert.equal(keep.has(file), true, file)
    }
    assert.equal(keep.has('extra.py'), false)
    assert.equal(keep.has('README.md'), false)

    const { up, repo, p } = setup()
    write(path.join(up, 'LICENSE'), 'MIT\n')
    write(path.join(up, 'extra.py'), 'x = 1\n')
    write(path.join(up, 'agent/__init__.py'), '')
    write(path.join(up, 'agent/notes.yaml'), 'k: 1\n')
    write(path.join(up, 'agent/core.py'), 'def run():\n    return "notes.yaml"\n')
    git(up, 'add', '-A')
    git(up, 'commit', '-q', '-m', 'v1 data')
    git(up, 'tag', '-f', 'v1')
    write(path.join(p.hermes, 'CUTTLELY_LOADED.txt'), '# measured\ntool.py\nagent/core.py\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'loaded list')
    vendor(p, 'v1', quiet)
    assert.ok(exists(p, 'tool.py') && exists(p, 'agent/core.py') && exists(p, 'agent/__init__.py'))
    assert.ok(exists(p, 'agent/notes.yaml') && exists(p, 'LICENSE'))
    assert.ok(!exists(p, 'extra.py') && !exists(p, 'README.md') && !exists(p, 'run.sh'))
    assert.equal(read(p, 'CUTTLELY_LOADED.txt'), '# measured\ntool.py\nagent/core.py\n')
    assert.deepEqual(check(p), [])
    commitAll(repo, 'subset')
    vendor(p, 'v1', quiet)
    assert.equal(git(repo, 'status', '--porcelain'), '', 'vendoring the same measured list again changes nothing')
})

test('vendoring refuses main, uncommitted hermes/ edits, and a missing ref', () => {
    const { repo, p } = setup()
    assert.throws(() => vendor(p, '', quiet), /Name a tag or commit/)
    write(path.join(p.hermes, 'scratch.txt'), 'x\n')
    assert.throws(() => vendor(p, 'v1', quiet), /uncommitted changes/)
    fs.rmSync(path.join(p.hermes, 'scratch.txt'))
    git(repo, 'checkout', '-q', 'main')
    assert.throws(() => vendor(p, 'v1', quiet), /not main/)
})
