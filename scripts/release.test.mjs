import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertIsolated, isolateProcessEnv, testGit, withoutGitEnv } from './test-git.mjs'
import {
    ReleaseError,
    buildxInfo,
    bumpVersion,
    canBuildMultiArch,
    compareSemver,
    dockerPlan,
    parseArgs,
    plannedVersion,
    preflightProblems,
    releaseNotes,
    releaseSection,
    VERSION_FILES,
    setPackageVersion,
    slugFromRemote,
    updateChangelog
} from './release.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release.mjs')

const CHANGELOG = `# Changelog

Intro.

## [1.0.0] - Unreleased

The first release.

### Harnesses

-   Teams.

[1.0.0]: https://github.com/acme/cuttlely/commits/main
`

test('parseArgs reads the version and flags, and keeps --local apart from --push and --publish', () => {
    assert.deepEqual(parseArgs(['v1.2.3', '--dry-run']), {
        version: '1.2.3',
        dryRun: true,
        local: false,
        push: false,
        publish: false,
        image: null,
        skipImageCheck: false,
        help: false
    })
    const o = parseArgs(['--push', '--publish', '--image', 'ghcr.io/a/b'])
    assert.equal(o.push && o.publish, true)
    assert.equal(o.image, 'ghcr.io/a/b')
    assert.throws(() => parseArgs(['--local', '--push']), ReleaseError)
    assert.throws(() => parseArgs(['--nope']), /Unknown option/)
    assert.throws(() => parseArgs(['1.0.0', '1.0.1']), /one version/)
})

test('versions compare and bump by semver rules', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
    assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), -1)
    assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1)
    assert.equal(compareSemver('1.10.0', '1.9.9'), 1)
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4')
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0')
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0')
    assert.equal(bumpVersion('1.3.0-rc.1', 'patch'), '1.3.0')
})

test('setPackageVersion changes only the top-level version and keeps the formatting', () => {
    const text = '{\n    "name": "x",\n    "version": "1.0.0",\n    "scripts": {\n        "version": "keep me"\n    }\n}\n'
    const next = setPackageVersion(text, '1.1.0')
    assert.equal(next, text.replace('"version": "1.0.0"', '"version": "1.1.0"'))
    assert.equal(JSON.parse(next).scripts.version, 'keep me')
    assert.throws(() => setPackageVersion('{\n    "name": "x"\n}\n', '1.0.0'), ReleaseError)
})

test('the changelog: a planned version, or [Unreleased], becomes the dated release with compare links', () => {
    assert.equal(plannedVersion(CHANGELOG), '1.0.0')
    const first = updateChangelog(CHANGELOG, { version: '1.0.0', date: '2026-10-20', slug: 'acme/cuttlely', previousTag: null })
    assert.match(first, /## \[Unreleased\]\n\n## \[1\.0\.0\] - 2026-10-20\n\nThe first release\./)
    assert.match(
        first,
        /\[Unreleased\]: https:\/\/github\.com\/acme\/cuttlely\/compare\/v1\.0\.0\.\.\.HEAD\n\[1\.0\.0\]: https:\/\/github\.com\/acme\/cuttlely\/releases\/tag\/v1\.0\.0\n$/
    )
    assert.doesNotMatch(first, /commits\/main/)
    assert.equal(plannedVersion(first), null)

    assert.throws(() => releaseSection(first, '1.0.1'), /nothing to release/)
    const withFix = first.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n-   A fix.\n')
    const second = updateChangelog(withFix, { version: '1.0.1', date: '2026-11-01', slug: 'acme/cuttlely', previousTag: 'v1.0.0' })
    assert.match(second, /## \[Unreleased\]\n\n## \[1\.0\.1\] - 2026-11-01\n\n### Fixed\n\n- {3}A fix\.\n\n## \[1\.0\.0\] - 2026-10-20/)
    assert.match(second, /\[1\.0\.1\]: https:\/\/github\.com\/acme\/cuttlely\/compare\/v1\.0\.0\.\.\.v1\.0\.1/)
    assert.equal((second.match(/^\[Unreleased\]:/gm) || []).length, 1)
    assert.throws(() => releaseSection(second, '1.0.0'), /already has a dated 1\.0\.0/)

    const linked = releaseNotes(
        '## [2.0.0] - Unreleased\n\nSee [Upgrading](./docs/upgrading.md), [semver](https://semver.org/) and [top](#x).\n',
        '2.0.0',
        { slug: 'acme/cuttlely' }
    )
    assert.equal(
        linked,
        'See [Upgrading](https://github.com/acme/cuttlely/blob/v2.0.0/docs/upgrading.md), [semver](https://semver.org/) and [top](#x).\n'
    )
    const notes = releaseNotes(second, '1.0.1', { image: 'ghcr.io/acme/cuttlely' })
    assert.match(notes, /^### Fixed\n\n- {3}A fix\.\n\n### Docker image\n\n```\ndocker pull ghcr\.io\/acme\/cuttlely:1\.0\.1\n```\n$/)
})

test('the changelog refuses an empty or ambiguous release', () => {
    assert.throws(() => releaseSection('# C\n\n## [Unreleased]\n\nNothing yet.\n', '1.0.0'), /nothing to release/)
    assert.throws(() => releaseSection('# C\n\n## [2.0.0] - Unreleased\n\n', '2.0.0'), /is empty/)
    assert.throws(() => releaseSection('# C\n\n## [Unreleased]\n\n-   a\n\n## [2.0.0] - Unreleased\n\n-   b\n', '2.0.0'), /both/)
})

test('docker plan: amd64 locally; multi-arch only with a builder that can, and only on push', () => {
    const base = { image: 'ghcr.io/acme/cuttlely', version: '1.0.0', sha: 'abc', slug: 'acme/cuttlely', created: 'now' }
    const local = dockerPlan({ ...base, multiArch: true, push: false })
    assert.deepEqual(local.tags, ['ghcr.io/acme/cuttlely:1.0.0', 'ghcr.io/acme/cuttlely:latest'])
    assert.deepEqual(local.local.slice(0, 3), ['build', '--platform', 'linux/amd64'])
    assert.ok(local.local.includes('org.opencontainers.image.revision=abc'))
    assert.deepEqual(local.push, [])
    const multi = dockerPlan({ ...base, multiArch: true, push: true })
    assert.equal(multi.push.length, 1)
    assert.ok(multi.push[0].includes('linux/amd64,linux/arm64') && multi.push[0].includes('--push'))
    const single = dockerPlan({ ...base, multiArch: false, push: true })
    assert.deepEqual(single.push, [
        ['push', 'ghcr.io/acme/cuttlely:1.0.0'],
        ['push', 'ghcr.io/acme/cuttlely:latest']
    ])
    assert.deepEqual(dockerPlan({ ...base, version: '1.1.0-rc.1', multiArch: false, push: false }).tags, [
        'ghcr.io/acme/cuttlely:1.1.0-rc.1'
    ])

    assert.equal(canBuildMultiArch(buildxInfo('Name: default\nDriver: docker\nPlatforms: linux/amd64, linux/arm64\n')), false)
    assert.equal(
        canBuildMultiArch(buildxInfo('Name: b\nDriver: docker-container\n Platforms: linux/amd64*, linux/arm64, linux/386\n')),
        true
    )
    assert.equal(canBuildMultiArch(buildxInfo('Driver: docker-container\nPlatforms: linux/amd64\n')), false)
    assert.equal(slugFromRemote('git@github.com:acme/cuttlely.git'), 'acme/cuttlely')
    assert.equal(slugFromRemote('https://github.com/acme/cuttlely'), 'acme/cuttlely')
    assert.equal(slugFromRemote('https://example.com/acme/cuttlely'), null)
})

test('preflight lists every reason to refuse', () => {
    const ok = {
        dirty: [],
        branch: 'main',
        head: 'a',
        originMain: 'a',
        resume: null,
        version: '1.0.0',
        currentVersion: '1.0.0',
        latestTag: null,
        localTag: false,
        remoteTag: false,
        docker: true,
        gh: true,
        local: false,
        push: false,
        publish: false
    }
    assert.deepEqual(preflightProblems(ok), [])
    const bad = preflightProblems({
        ...ok,
        dirty: [' M x'],
        branch: 'feature',
        originMain: 'b',
        localTag: true,
        latestTag: 'v1.0.0',
        docker: false,
        gh: false,
        publish: true,
        image: 'i',
        changelogProblem: 'CHANGELOG.md has nothing to release for 1.0.0.'
    })
    for (const needle of [
        'not clean',
        'cut from main',
        'not in sync',
        'already exists here',
        'not newer',
        'nothing to release',
        'docker was not found',
        'gh is not',
        '--publish needs'
    ]) {
        assert.ok(
            bad.some((p) => p.includes(needle)),
            needle
        )
    }
    assert.deepEqual(preflightProblems({ ...ok, gh: false, local: true }), [])
})

// End to end against a throwaway repository, a bare origin, and stub docker, gh and pnpm.
isolateProcessEnv()
let TMP_ROOT
function sh(cwd, cmd, args) {
    const res =
        cmd === 'git' ? testGit(cwd, args, { tmpRoot: TMP_ROOT }) : spawnSync(cmd, args, { cwd, encoding: 'utf8', env: withoutGitEnv() })
    if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${res.stderr}`)
    return res.stdout.trim()
}

function fixture() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-release-test-')))
    TMP_ROOT = dir
    const origin = path.join(dir, 'origin.git')
    const repo = path.join(dir, 'repo')
    const bin = path.join(dir, 'bin')
    const log = path.join(dir, 'calls.log')
    fs.mkdirSync(bin)
    sh(dir, 'git', ['init', '-q', '--bare', '-b', 'main', origin])
    sh(dir, 'git', ['init', '-q', '-b', 'main', repo])
    for (const [k, v] of [
        ['user.name', 'Release Test'],
        ['user.email', 'release-test@example.invalid'],
        ['commit.gpgsign', 'false'],
        ['tag.gpgsign', 'false']
    ]) {
        sh(repo, 'git', ['config', k, v])
    }
    fs.mkdirSync(path.join(repo, 'packages', 'server'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'packages', 'cli'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'packages', 'chat-widget'), { recursive: true })
    fs.writeFileSync(
        path.join(repo, 'package.json'),
        '{\n    "name": "cuttlely-workspace",\n    "version": "1.0.0",\n    "private": true\n}\n'
    )
    fs.writeFileSync(path.join(repo, 'packages', 'server', 'package.json'), '{\n    "name": "flowise",\n    "version": "1.0.0"\n}\n')
    fs.writeFileSync(path.join(repo, 'packages', 'cli', 'package.json'), '{\n    "name": "cuttlely",\n    "version": "1.0.0"\n}\n')
    fs.writeFileSync(
        path.join(repo, 'packages', 'chat-widget', 'package.json'),
        '{\n    "name": "@cuttlely/chat",\n    "version": "1.0.0"\n}\n'
    )
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), CHANGELOG)
    sh(repo, 'git', ['add', '.'])
    sh(repo, 'git', ['commit', '-q', '-m', 'init'])
    sh(repo, 'git', ['remote', 'add', 'origin', 'https://github.com/acme/cuttlely.git'])
    sh(repo, 'git', ['config', `url.${origin}.insteadOf`, 'https://github.com/acme/cuttlely.git'])
    sh(repo, 'git', ['push', '-q', 'origin', 'main'])
    sh(repo, 'git', ['fetch', '-q', 'origin'])

    const stub = (name, body) => {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 })
    }
    stub(
        'docker',
        `case "$1 $2" in
  "version "*) echo 26.0.0 ;;
  "buildx inspect") printf 'Name: default\\nDriver: docker\\nPlatforms: linux/amd64\\n' ;;
  "image inspect") exit 1 ;;
  "exec "*) echo '{"message":"pong"}' ;;
  "inspect "*) echo true ;;
  "manifest inspect") exit 1 ;;
esac
exit 0`
    )
    stub(
        'gh',
        `case "$1 $2" in
  "auth status") exit 0 ;;
  "release view") [ -f "${dir}/released" ] || exit 1; cat "${dir}/released" ;;
  "release create") case "$*" in *--draft*) echo true > "${dir}/released" ;; *) echo false > "${dir}/released" ;; esac ;;
  "release edit") echo false > "${dir}/released" ;;
esac
exit 0`
    )
    stub('pnpm', 'exit 0')
    for (const tool of ['git', 'sh', 'cat', 'printf', 'echo']) {
        const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
        if (found && found.startsWith('/') && !fs.existsSync(path.join(bin, tool))) fs.symlinkSync(found, path.join(bin, tool))
    }
    const runRelease = (args) => {
        assertIsolated(repo, dir)
        const res = spawnSync(process.execPath, [SCRIPT, ...args], {
            cwd: repo,
            encoding: 'utf8',
            env: { PATH: bin, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', TZ: 'America/Chicago' }
        })
        return { code: res.status, out: `${res.stdout}${res.stderr}` }
    }
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
    return { repo, origin, runRelease, calls, cleanup, dir }
}

test('dry run on a clean, synced main passes and changes nothing', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const before = sh(f.repo, 'git', ['rev-parse', 'HEAD'])
    const res = f.runRelease(['--dry-run'])
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /Version 1\.0\.0 comes from CHANGELOG\.md/)
    assert.match(res.out, /docker build --platform linux\/amd64 -t ghcr\.io\/acme\/cuttlely:1\.0\.0 -t ghcr\.io\/acme\/cuttlely:latest/)
    assert.match(res.out, /gh release create v1\.0\.0 .*--draft/)
    assert.doesNotMatch(res.out, /docker push/)
    assert.match(res.out, /Dry run passed/)
    assert.equal(sh(f.repo, 'git', ['rev-parse', 'HEAD']), before)
    assert.equal(sh(f.repo, 'git', ['status', '--porcelain']), '')
    assert.equal(sh(f.repo, 'git', ['tag']), '')
    assert.doesNotMatch(f.calls(), /docker (build |push|run)|gh release create|pnpm verify/)
})

test('dry run refuses a dirty tree, another branch, and a main that is behind origin', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    fs.writeFileSync(path.join(f.repo, 'stray.txt'), 'x')
    let res = f.runRelease(['--dry-run'])
    assert.equal(res.code, 1)
    assert.match(res.out, /not clean/)
    fs.rmSync(path.join(f.repo, 'stray.txt'))

    sh(f.repo, 'git', ['checkout', '-q', '-b', 'side'])
    res = f.runRelease(['--dry-run'])
    assert.equal(res.code, 1)
    assert.match(res.out, /This checkout is on side/)
    sh(f.repo, 'git', ['checkout', '-q', 'main'])

    sh(f.repo, 'git', ['commit', '-q', '--allow-empty', '-m', 'local only'])
    res = f.runRelease(['--dry-run'])
    assert.equal(res.code, 1)
    assert.match(res.out, /not in sync with origin\/main/)
})

test('a real run with --local commits, tags and builds, and nothing leaves the machine', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const res = f.runRelease(['--local'])
    assert.equal(res.code, 0, res.out)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.repo, 'package.json'), 'utf8')).version, '1.0.0')
    assert.match(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), /## \[1\.0\.0\] - \d{4}-\d{2}-\d{2}/)
    assert.equal(sh(f.repo, 'git', ['cat-file', '-t', 'v1.0.0']), 'tag')
    assert.equal(sh(f.repo, 'git', ['log', '-1', '--format=%s']), 'Release v1.0.0')
    assert.equal(sh(f.repo, 'git', ['ls-remote', '--tags', f.origin]), '')
    const calls = f.calls()
    assert.match(calls, /pnpm verify/)
    assert.match(calls, /docker build --platform linux\/amd64/)
    assert.match(calls, /docker run -d --name cuttlely-release-check-/)
    assert.doesNotMatch(calls, /docker push|gh release/)
})

test('a minor release bumps both package files; then a resumed run drafts, and --push --publish finishes', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    assert.equal(f.runRelease(['--skip-image-check']).code, 0)
    assert.equal(fs.readFileSync(`${f.dir}/released`, 'utf8').trim(), 'true')
    assert.match(sh(f.repo, 'git', ['ls-remote', '--tags', f.origin]), /refs\/tags\/v1\.0\.0/)

    fs.writeFileSync(
        path.join(f.repo, 'CHANGELOG.md'),
        fs
            .readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8')
            .replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n-   More.\n')
    )
    sh(f.repo, 'git', ['commit', '-q', '-am', 'changelog'])
    sh(f.repo, 'git', ['push', '-q', 'origin', 'main'])
    fs.rmSync(`${f.dir}/released`)
    let res = f.runRelease(['minor', '--local', '--skip-image-check'])
    assert.equal(res.code, 0, res.out)
    for (const file of VERSION_FILES) {
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.repo, file), 'utf8')).version, '1.1.0', file)
    }
    res = f.runRelease(['1.1.0', '--push', '--publish', '--skip-image-check'])
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /Resuming: v1\.1\.0 is already on this commit/)
    assert.match(f.calls(), /docker push ghcr\.io\/acme\/cuttlely:1\.1\.0/)
    assert.match(f.calls(), /gh release create v1\.1\.0 .*--latest/)
    assert.equal(fs.readFileSync(`${f.dir}/released`, 'utf8').trim(), 'false')
    assert.match(sh(f.repo, 'git', ['ls-remote', '--tags', f.origin]), /refs\/tags\/v1\.1\.0/)
})
