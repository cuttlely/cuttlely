import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertIsolated, isolateProcessEnv, testGit, withoutGitEnv } from './test-git.mjs'
import {
    HELP,
    NPM_IMAGE,
    NPM_PACKAGE_FILES,
    ReleaseError,
    VERSION_FILES,
    anonymousBearerChallenge,
    anonymousManifestExists,
    buildxInfo,
    bumpVersion,
    canBuildMultiArch,
    ciImagePlan,
    compareSemver,
    defaultImage,
    dockerPlan,
    imageLabels,
    main,
    npmImageRef,
    npmPublishProblems,
    parseArgs,
    plannedVersion,
    preflightProblems,
    pickReleasePr,
    releaseBranch,
    remoteTagCommit,
    syncPrBody,
    syncPrDecision,
    syncPrTitle,
    tagProblems,
    redactSecret,
    releaseNotes,
    releaseSection,
    setPackageVersion,
    slugFromRemote,
    updateChangelog,
    waitForRegistryImage
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
        localImage: false,
        push: false,
        publish: false,
        npm: false,
        image: null,
        skipImageCheck: false,
        help: false
    })
    const o = parseArgs(['--local-image', '--push', '--publish', '--image', 'ghcr.io/a/b'])
    assert.equal(o.push && o.publish, true)
    assert.equal(o.image, 'ghcr.io/a/b')
    assert.equal(parseArgs(['1.0.1', '--npm']).npm, true)
    assert.throws(() => parseArgs(['--local', '--push']), ReleaseError)
    assert.equal(parseArgs(['--local']).localImage, true)
    assert.throws(() => parseArgs(['--push']), /Add --local-image/)
    assert.throws(() => parseArgs(['--image', 'ghcr.io/a/b']), /Add --local-image/)
    assert.throws(() => parseArgs(['--npm', '--push']), /on its own/)
    assert.throws(() => parseArgs(['--npm', '--publish']), /on its own/)
    assert.throws(() => parseArgs(['--npm', '--local']), /on its own/)
    assert.throws(() => parseArgs(['--npm']), /needs a version/)
    assert.throws(() => parseArgs(['patch', '--npm']), /exact version/)
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
    assert.throws(() => releaseSection('# C\n\n## [2.0.0] - Unreleased\n\n<!<!-- a -->-- b -->\n', '2.0.0'), /is empty/)
    assert.equal(releaseSection('# C\n\n## [2.0.0] - Unreleased\n\n<!-- a -->\n-   b\n', '2.0.0').kind, 'planned')
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

test('CI image plans release, test-tag and dispatch modes from one label source', () => {
    const base = {
        packageVersion: '1.5.3',
        sha: 'abc123',
        slug: 'cuttlely/cuttlely',
        created: '2026-11-03T12:00:00.000Z',
        image: defaultImage('cuttlely/cuttlely')
    }
    const stable = ciImagePlan({ ...base, event: 'push', ref: 'refs/tags/v1.5.3' })
    assert.deepEqual(stable.errors, [])
    assert.deepEqual(stable.tags, ['ghcr.io/cuttlely/cuttlely:1.5.3', 'ghcr.io/cuttlely/cuttlely:latest'])
    assert.equal(stable.latest, true)
    assert.equal(stable.guard, true)
    assert.equal(stable.platforms, 'linux/amd64')
    assert.deepEqual(stable.labels, imageLabels({ version: '1.5.3', sha: base.sha, slug: base.slug, created: base.created }))

    const prerelease = ciImagePlan({ ...base, packageVersion: '1.5.3-rc.0', event: 'push', ref: 'v1.5.3-rc.0' })
    assert.deepEqual(prerelease.errors, [])
    assert.deepEqual(prerelease.tags, ['ghcr.io/cuttlely/cuttlely:1.5.3-rc.0'])
    assert.equal(prerelease.latest, false)

    const mismatch = ciImagePlan({ ...base, packageVersion: '1.5.2', event: 'push', ref: 'v1.5.3' })
    assert.match(mismatch.errors.join('\n'), /does not match/)

    const testTag = ciImagePlan({ ...base, packageVersion: '0.0.0', event: 'push', ref: 'refs/tags/ci-dryrun-42' })
    assert.deepEqual(testTag.errors, [])
    assert.deepEqual(testTag.tags, ['ghcr.io/cuttlely/cuttlely:ci-dryrun-42'])
    assert.equal(testTag.latest, false)
    assert.equal(testTag.guard, false)
    assert.equal(testTag.platforms, 'linux/amd64')

    for (const [tag, packageVersion] of [
        ['ci-manual-42', '0.0.0'],
        ['1.5.3-rc.7', '1.5.3-rc.7']
    ]) {
        const dispatch = ciImagePlan({
            ...base,
            packageVersion,
            event: 'workflow_dispatch',
            inputTag: tag,
            inputPlatforms: 'linux/amd64'
        })
        assert.deepEqual(dispatch.errors, [])
        assert.deepEqual(dispatch.tags, [`ghcr.io/cuttlely/cuttlely:${tag}`])
        assert.equal(dispatch.latest, false)
        assert.equal(dispatch.platforms, 'linux/amd64')
    }
    const dispatchOptIn = ciImagePlan({
        ...base,
        event: 'workflow_dispatch',
        inputTag: 'ci-arm64',
        inputPlatforms: 'linux/amd64,linux/arm64'
    })
    assert.deepEqual(dispatchOptIn.errors, [])
    assert.equal(dispatchOptIn.platforms, 'linux/amd64,linux/arm64')
    const dispatchReversed = ciImagePlan({
        ...base,
        event: 'workflow_dispatch',
        inputTag: 'ci-arm64-reversed',
        inputPlatforms: 'linux/arm64,linux/amd64'
    })
    assert.deepEqual(dispatchReversed.errors, [])
    assert.equal(dispatchReversed.platforms, 'linux/amd64,linux/arm64')
    for (const inputPlatforms of ['linux/arm64', 'linux/amd64,linux/386', 'linux/amd64, linux/arm64']) {
        const plan = ciImagePlan({ ...base, event: 'workflow_dispatch', inputTag: 'ci-bad-platforms', inputPlatforms })
        assert.match(plan.errors.join('\n'), /Platforms must be linux\/amd64 or linux\/amd64,linux\/arm64/)
    }
    const dispatchEmpty = ciImagePlan({ ...base, event: 'workflow_dispatch', inputTag: 'ci-empty-platforms', inputPlatforms: '' })
    assert.deepEqual(dispatchEmpty.errors, [])
    assert.equal(dispatchEmpty.platforms, 'linux/amd64')
    const dispatchMismatch = ciImagePlan({
        ...base,
        packageVersion: '1.5.2',
        event: 'workflow_dispatch',
        inputTag: '1.5.3-rc.7',
        inputPlatforms: 'linux/amd64'
    })
    assert.match(dispatchMismatch.errors.join('\n'), /Tag 1\.5\.3-rc\.7 does not match the root package\.json version 1\.5\.2/)
    const invalidDispatchTag = ciImagePlan({
        ...base,
        event: 'workflow_dispatch',
        inputTag: 'ci-feature/foo',
        inputPlatforms: 'linux/amd64'
    })
    assert.match(invalidDispatchTag.errors.join('\n'), /does not match the Docker tag grammar/)
    const invalidTestTag = ciImagePlan({ ...base, event: 'push', ref: 'refs/tags/ci-dryrun-feature/foo' })
    assert.match(invalidTestTag.errors.join('\n'), /does not match the Docker tag grammar/)
    const refused = ciImagePlan({
        ...base,
        event: 'workflow_dispatch',
        inputTag: '1.5.3',
        inputPlatforms: 'linux/amd64'
    })
    assert.match(refused.errors.join('\n'), /must start with ci-/)
})

test('preflight lists every reason to refuse', () => {
    const ok = {
        dirty: [],
        branch: 'main',
        head: 'a',
        originMain: 'a',
        version: '1.0.0',
        currentVersion: '1.0.0',
        latestTag: null,
        localTag: false,
        remoteTag: false,
        docker: true,
        gh: true,
        localImage: false,
        local: false,
        push: false,
        publish: false,
        image: 'ghcr.io/acme/cuttlely',
        workflowImage: 'ghcr.io/acme/cuttlely'
    }
    assert.deepEqual(preflightProblems(ok), [])
    assert.deepEqual(preflightProblems({ ...ok, image: 'ghcr.io/acme/other' }), [
        'The release image workflow publishes only to ghcr.io/acme/cuttlely. Use --push with a custom --image.'
    ])
    assert.deepEqual(preflightProblems({ ...ok, image: 'ghcr.io/acme/other', push: true }), [])
    assert.deepEqual(preflightProblems({ ...ok, localImage: true, publish: true }), [])
    const bad = preflightProblems({
        ...ok,
        dirty: [' M x'],
        branch: 'feature',
        originMain: 'b',
        localTag: true,
        latestTag: 'v1.0.0',
        localImage: true,
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
        'gh is not'
    ]) {
        assert.ok(
            bad.some((p) => p.includes(needle)),
            needle
        )
    }
    assert.deepEqual(preflightProblems({ ...ok, gh: false, local: true }), [])
    assert.deepEqual(preflightProblems({ ...ok, localBranch: true }), ['Branch release/v1.0.0 already exists here.'])
    assert.deepEqual(preflightProblems({ ...ok, remoteBranch: true }), ['Branch release/v1.0.0 already exists on origin.'])
    assert.deepEqual(preflightProblems({ ...ok, remoteBranch: true, local: true, localImage: true }), [])
    assert.equal(releaseBranch('1.2.3-rc.1'), 'release/v1.2.3-rc.1')
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
    const fetchStub = path.join(dir, 'fetch-stub.mjs')
    fs.mkdirSync(bin)
    fs.writeFileSync(
        fetchStub,
        `import { appendFileSync } from 'node:fs'\n` +
            `globalThis.fetch = async () => { appendFileSync(${JSON.stringify(
                log
            )}, 'registry fetch\\n'); return { status: 200, ok: true, headers: { get() { return null } } } }\n`
    )
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
    fs.writeFileSync(
        path.join(repo, 'packages', 'server', 'package.json'),
        '{\n    "name": "@cuttlely/server",\n    "version": "1.0.0"\n}\n'
    )
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
    sh(repo, 'git', ['push', '-q', 'origin', 'main:dev'])
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
esac
exit 0`
    )
    stub(
        'gh',
        `case "$1 $2" in
  "auth status") exit 0 ;;
  "run list") echo '[{"databaseId":1,"status":"completed","conclusion":"success","headBranch":"v1.0.0","url":"https://github.com/acme/cuttlely/actions/runs/1"}]' ;;
  "release view") [ -f "${dir}/released" ] || exit 1; cat "${dir}/released" ;;
  "release create") case "$*" in *--draft*) echo true > "${dir}/released" ;; *) echo false > "${dir}/released" ;; esac ;;
  "release edit") echo false > "${dir}/released" ;;
  "pr list") case "$*" in *"--base dev"*) cat "${dir}/sync-prs.json" 2>/dev/null || echo '[]' ;; *) cat "${dir}/release-prs.json" 2>/dev/null || echo '[]' ;; esac ;;
  "pr create") case "$*" in *"--base dev"*) echo https://github.com/acme/cuttlely/pull/2 ;; *) echo https://github.com/acme/cuttlely/pull/1 ;; esac ;;
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
            env: {
                PATH: bin,
                HOME: dir,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_TERMINAL_PROMPT: '0',
                NODE_OPTIONS: `--import=${fetchStub}`,
                TZ: 'America/Chicago'
            }
        })
        return {
            code: res.status,
            out: `${res.stdout || ''}${res.stderr || ''}${res.error ? `\n${res.error.message}` : ''}${
                res.signal ? `\nsignal ${res.signal}` : ''
            }`
        }
    }
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
    const writePrs = (prs) => fs.writeFileSync(path.join(dir, 'release-prs.json'), JSON.stringify(prs))
    // Stands in for GitHub listing the release pull request as still open.
    const openPr = (version) =>
        writePrs([
            {
                number: 1,
                state: 'OPEN',
                url: 'https://github.com/acme/cuttlely/pull/1',
                headRefOid: sh(repo, 'git', ['rev-parse', `release/v${version}`])
            }
        ])
    // Stands in for a human squash-merging the release pull request on GitHub: one new commit on main
    // with the release branch's changes, then GitHub lists the pull request as merged. With moveMain,
    // main gets another commit first, so the squash has a tree nobody reviewed.
    const squashMerge = (version, { moveMain = false } = {}) => {
        const prHead = sh(repo, 'git', ['rev-parse', `release/v${version}`])
        sh(repo, 'git', ['switch', '-q', 'main'])
        if (moveMain) {
            fs.writeFileSync(path.join(repo, 'later.txt'), 'landed after the branch was cut\n')
            sh(repo, 'git', ['add', 'later.txt'])
            sh(repo, 'git', ['commit', '-q', '-m', 'later'])
        }
        sh(repo, 'git', ['merge', '-q', '--squash', `release/v${version}`])
        sh(repo, 'git', ['commit', '-q', '-m', `Release v${version} (#1)`])
        sh(repo, 'git', ['push', '-q', 'origin', 'main'])
        const mergeSha = sh(repo, 'git', ['rev-parse', 'HEAD'])
        writePrs([
            {
                number: 1,
                state: 'MERGED',
                url: 'https://github.com/acme/cuttlely/pull/1',
                headRefOid: prHead,
                mergeCommit: { oid: mergeSha }
            }
        ])
        return mergeSha
    }
    const remoteTags = () => sh(repo, 'git', ['ls-remote', '--tags', origin])
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
    return { repo, origin, runRelease, calls, cleanup, dir, openPr, squashMerge, remoteTags }
}

test('dry run on a clean, synced main passes and changes nothing', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const before = sh(f.repo, 'git', ['rev-parse', 'HEAD'])
    const res = f.runRelease(['--dry-run'])
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /Version 1\.0\.0 comes from CHANGELOG\.md/)
    assert.match(res.out, /git switch -c release\/v1\.0\.0/)
    assert.match(res.out, /git push -u origin release\/v1\.0\.0/)
    assert.match(res.out, /gh pr create --base main --head release\/v1\.0\.0/)
    assert.match(res.out, /then a human founder merges the pull request, and pnpm release 1\.0\.0 \(phase 2\) tags the merged commit/)
    assert.doesNotMatch(res.out, /git tag|HEAD:main|gh release create/)
    assert.doesNotMatch(res.out, /docker build|docker push/)
    assert.match(res.out, /Dry run passed/)
    assert.equal(sh(f.repo, 'git', ['rev-parse', 'HEAD']), before)
    assert.equal(sh(f.repo, 'git', ['status', '--porcelain']), '')
    assert.equal(sh(f.repo, 'git', ['tag']), '')
    assert.equal(sh(f.repo, 'git', ['branch', '--list', 'release/*']), '')
    assert.doesNotMatch(f.calls(), /docker |gh release create|gh pr create|pnpm verify/)
})

test('--local-image keeps the maintainer-machine image plan', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const res = f.runRelease(['--local-image', '--dry-run'])
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /docker build --platform linux\/amd64/)
    assert.match(res.out, /temporary volume and wait for \/api\/v1\/ping/)
    assert.match(f.calls(), /docker version/)
    assert.match(f.calls(), /docker buildx inspect/)
    assert.doesNotMatch(f.calls(), /docker build --platform|docker run/)
})

test('--local-image --publish waits for the workflow image without a registry probe', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    assert.equal(f.runRelease(['--local', '--skip-image-check']).code, 0)
    const mergeSha = f.squashMerge('1.0.0')
    const res = f.runRelease(['1.0.0', '--local-image', '--publish', '--dry-run'])
    assert.equal(res.code, 0, res.out)
    assert.ok(res.out.includes(`git tag -a v1.0.0 ${mergeSha} -m "Cuttlely 1.0.0"`), res.out)
    assert.match(res.out, /git push origin refs\/tags\/v1\.0\.0/)
    assert.equal(f.remoteTags(), '')
    assert.match(
        res.out,
        /wait for the \.github\/workflows\/release-image\.yml run for v1\.0\.0 to pass and ghcr\.io\/acme\/cuttlely:1\.0\.0 to be available/
    )
    assert.doesNotMatch(f.calls(), /manifest inspect/)
})

test('a local push does not start an anonymous registry wait', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const local = f.runRelease(['--local', '--skip-image-check'])
    assert.equal(local.code, 0, local.out)
    f.squashMerge('1.0.0')
    const pushed = f.runRelease(['1.0.0', '--local-image', '--push', '--skip-image-check'])
    assert.equal(pushed.code, 0, pushed.out)
    assert.doesNotMatch(pushed.out, /Wait for ghcr\.io/)
    assert.doesNotMatch(f.calls(), /registry fetch/)
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

test('a real run with --local commits on the release branch without a tag, builds, and nothing leaves the machine', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const res = f.runRelease(['--local'])
    assert.equal(res.code, 0, res.out)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.repo, 'package.json'), 'utf8')).version, '1.0.0')
    assert.match(fs.readFileSync(path.join(f.repo, 'CHANGELOG.md'), 'utf8'), /## \[1\.0\.0\] - \d{4}-\d{2}-\d{2}/)
    assert.equal(sh(f.repo, 'git', ['tag']), '')
    assert.equal(sh(f.repo, 'git', ['branch', '--show-current']), 'release/v1.0.0')
    assert.equal(sh(f.repo, 'git', ['log', '-1', '--format=%s']), 'Release v1.0.0')
    assert.equal(sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/heads/release/*', 'refs/tags/*']), '')
    assert.match(res.out, /there is no tag/)
    const calls = f.calls()
    assert.match(calls, /pnpm verify/)
    assert.match(calls, /docker build --platform linux\/amd64/)
    assert.match(calls, /docker run -d --name cuttlely-release-check-/)
    assert.doesNotMatch(calls, /docker push|gh release|gh pr/)
})

test('phase 1 opens a pull request into main and exits; phase 2 tags the merged squash commit and opens the dev sync', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const mainBefore = sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/heads/main'])
    const first = f.runRelease([])
    assert.equal(first.code, 0, first.out)
    assert.match(sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/heads/release/v1.0.0']), /refs\/heads\/release\/v1\.0\.0/)
    assert.equal(sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/heads/main']), mainBefore)
    assert.equal(f.remoteTags(), '')
    assert.equal(sh(f.repo, 'git', ['tag']), '')
    assert.match(f.calls(), /gh pr create --base main --head release\/v1\.0\.0 --title Release v1\.0\.0 --body-file /)
    assert.match(first.out, /A human founder merges it; a bot never does/)
    assert.doesNotMatch(first.out, /Wait for /)
    assert.doesNotMatch(f.calls(), /docker |gh release|gh pr merge/)
    assert.equal(fs.existsSync(`${f.dir}/released`), false)

    // Still open: phase 2 reports it and changes nothing.
    f.openPr('1.0.0')
    const waiting = f.runRelease(['1.0.0'])
    assert.equal(waiting.code, 0, waiting.out)
    assert.match(waiting.out, /still open: https:\/\/github\.com\/acme\/cuttlely\/pull\/1/)
    assert.equal(f.remoteTags(), '')

    const mergeSha = f.squashMerge('1.0.0')
    const mainMerged = sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/heads/main'])
    const drafted = f.runRelease(['1.0.0'])
    assert.equal(drafted.code, 0, drafted.out)
    assert.match(drafted.out, /Phase 2: release pull request #1 merged as /)
    assert.match(drafted.out, /Wait for \.github\/workflows\/release-image\.yml run for v1\.0\.0/)
    assert.equal(fs.readFileSync(`${f.dir}/released`, 'utf8').trim(), 'true')
    // The annotated tag is on the squash commit, only the tag was pushed, and main did not move.
    assert.equal(sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/tags/v1.0.0^{}']).split(/\s+/)[0], mergeSha)
    assert.equal(sh(f.repo, 'git', ['cat-file', '-t', 'v1.0.0']), 'tag')
    assert.equal(sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/heads/main']), mainMerged)
    assert.match(
        f.calls(),
        /gh pr create --repo acme\/cuttlely --base dev --head main --title Sync main into dev after v1\.0\.0 --body-file /
    )
    assert.doesNotMatch(f.calls(), /gh pr merge/)

    // A re-run reuses the tag and the release, and does not open a second sync pull request.
    fs.writeFileSync(`${f.dir}/sync-prs.json`, JSON.stringify([{ number: 2, url: 'https://github.com/acme/cuttlely/pull/2' }]))
    const again = f.runRelease(['1.0.0'])
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /Already on origin/)
    assert.match(again.out, /Skipped: A main to dev sync pull request is already open: https:\/\/github\.com\/acme\/cuttlely\/pull\/2/)
    assert.match(again.out, /The release already exists \(draft\)/)
    assert.equal(f.calls().match(/--base dev --head main --title/g).length, 1)
    fs.rmSync(`${f.dir}/sync-prs.json`)

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
    f.squashMerge('1.1.0')
    res = f.runRelease(['1.1.0', '--local-image', '--push', '--publish', '--skip-image-check'])
    assert.equal(res.code, 0, res.out)
    assert.match(f.calls(), /docker push ghcr\.io\/acme\/cuttlely:1\.1\.0/)
    assert.match(f.calls(), /gh release create v1\.1\.0 .*--latest/)
    assert.equal(fs.readFileSync(`${f.dir}/released`, 'utf8').trim(), 'false')
    assert.match(f.remoteTags(), /refs\/tags\/v1\.1\.0/)
})

test('phase 2 refuses a squash commit whose tree differs from the reviewed pull request head, and tags nothing', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    assert.equal(f.runRelease([]).code, 0)
    f.squashMerge('1.0.0', { moveMain: true })
    const res = f.runRelease(['1.0.0'])
    assert.equal(res.code, 1, res.out)
    assert.match(res.out, /does not have the tree of the reviewed pull request head/)
    assert.equal(f.remoteTags(), '')
    assert.equal(sh(f.repo, 'git', ['tag']), '')
    assert.doesNotMatch(f.calls(), /gh release create|--base dev --head main --title/)
})

test('phase 2 never moves a tag that already points elsewhere', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    const init = sh(f.repo, 'git', ['rev-parse', 'HEAD'])
    assert.equal(f.runRelease([]).code, 0)
    f.squashMerge('1.0.0')
    sh(f.repo, 'git', ['tag', '-a', 'v1.0.0', init, '-m', 'wrong'])
    sh(f.repo, 'git', ['push', '-q', 'origin', 'refs/tags/v1.0.0'])
    const res = f.runRelease(['1.0.0'])
    assert.equal(res.code, 1, res.out)
    assert.match(res.out, /Tag v1\.0\.0 on origin points at .*, not the merged commit/)
    assert.equal(sh(f.repo, 'git', ['ls-remote', f.origin, 'refs/tags/v1.0.0^{}']).split(/\s+/)[0], init)
    assert.doesNotMatch(f.calls(), /gh release create/)
})

test('phase 2 skips the dev sync pull request when dev already has main', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    assert.equal(f.runRelease([]).code, 0)
    f.squashMerge('1.0.0')
    sh(f.repo, 'git', ['push', '-q', 'origin', 'main:dev'])
    const res = f.runRelease(['1.0.0'])
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /Skipped: dev already has everything on main/)
    assert.doesNotMatch(f.calls(), /--base dev --head main --title/)
    assert.match(f.remoteTags(), /refs\/tags\/v1\.0\.0/)
})

test('phase 2 helpers: the merged pull request, the peeled remote tag, the sync decision, and every refusal', () => {
    assert.equal(pickReleasePr([]), null)
    const open = { state: 'OPEN', url: 'u' }
    const merged = { state: 'MERGED', mergeCommit: { oid: 'm' } }
    assert.equal(pickReleasePr([open, merged]), merged)
    assert.equal(pickReleasePr([{ state: 'CLOSED' }, open]), open)
    assert.equal(remoteTagCommit('t1\trefs/tags/v1.0.0\nc1\trefs/tags/v1.0.0^{}\n', 'v1.0.0'), 'c1')
    assert.equal(remoteTagCommit('c2\trefs/tags/v1.0.0\n', 'v1.0.0'), 'c2')
    assert.equal(remoteTagCommit('', 'v1.0.0'), null)
    assert.equal(syncPrTitle('1.2.3'), 'Sync main into dev after v1.2.3')
    assert.match(syncPrBody('1.2.3'), /merge commit or by fast-forward\. Do not squash it/)
    assert.deepEqual(syncPrDecision({ devExists: true, openSyncPrs: [], missingCommits: 2 }), { open: true, reason: null })
    assert.match(syncPrDecision({ devExists: true, openSyncPrs: [{ url: 'p' }], missingCommits: 2 }).reason, /already open: p/)
    assert.match(syncPrDecision({ devExists: true, openSyncPrs: [], missingCommits: 0 }).reason, /already has everything/)
    assert.match(syncPrDecision({ devExists: false, openSyncPrs: [], missingCommits: 0 }).reason, /no dev branch/)

    const release = {
        mergeSha: 'aaaaaaaa1',
        prHead: 'bbbbbbbb1',
        onMain: true,
        sameTree: true,
        versions: VERSION_FILES.map((file) => ({ file, version: '1.0.0' })),
        remoteTagSha: null,
        localTagSha: null
    }
    const ok = {
        release,
        version: '1.0.0',
        tag: 'v1.0.0',
        dirty: [],
        head: 'cccccccc1',
        localImage: false,
        docker: true,
        gh: true,
        push: false,
        image: 'ghcr.io/acme/cuttlely',
        workflowImage: 'ghcr.io/acme/cuttlely'
    }
    assert.deepEqual(tagProblems(ok), [])
    assert.deepEqual(tagProblems({ ...ok, release: { ...release, remoteTagSha: 'aaaaaaaa1' } }), [])
    const bad = tagProblems({
        ...ok,
        dirty: [' M x'],
        gh: false,
        localImage: true,
        release: {
            ...release,
            onMain: false,
            sameTree: false,
            versions: [{ file: 'package.json', version: '0.9.0' }],
            remoteTagSha: 'dddddddd1',
            localTagSha: 'eeeeeeee1'
        }
    })
    for (const needle of [
        'not clean',
        'not on origin/main',
        'does not have the tree',
        'is not version 1.0.0: package.json 0.9.0',
        'on origin points at',
        'here points at',
        'Check out the merged commit',
        'gh is not'
    ]) {
        assert.ok(
            bad.some((p) => p.includes(needle)),
            needle
        )
    }
})

test('dry run of 1.0.1 plans one version for the product, the launcher and the widget', (t) => {
    const f = fixture()
    t.after(f.cleanup)
    fs.writeFileSync(path.join(f.repo, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n-   A fix.\n')
    sh(f.repo, 'git', ['commit', '-q', '-am', 'notes'])
    sh(f.repo, 'git', ['push', '-q', 'origin', 'main'])
    const res = f.runRelease(['1.0.1', '--dry-run'])
    assert.equal(res.code, 0, res.out)
    assert.match(
        res.out,
        /set "version" to 1\.0\.1 in package\.json, packages\/server\/package\.json, packages\/cli\/package\.json, and packages\/chat-widget\/package\.json/
    )
    for (const file of [...VERSION_FILES, ...NPM_PACKAGE_FILES]) assert.match(res.out, new RegExp(file.replaceAll('.', '\\.')))
})

test('the launcher and the widget are version files, and the registry image tag is the release version', () => {
    assert.ok(VERSION_FILES.includes('packages/cli/package.json'))
    assert.ok(VERSION_FILES.includes('packages/chat-widget/package.json'))
    assert.deepEqual(NPM_PACKAGE_FILES, ['packages/cli/package.json', 'packages/chat-widget/package.json'])
    assert.equal(npmImageRef('1.0.1'), `${NPM_IMAGE}:1.0.1`)
    assert.match(HELP, /--npm/)
    assert.match(HELP, /--local-image/)
    assert.equal(redactSecret('token secret-value in the log', 'secret-value'), 'token NPM_TOKEN in the log')
})

test('unpublished workspace packages are private, and the root workspace list matches pnpm-workspace.yaml', () => {
    const rootDir = path.resolve(path.dirname(SCRIPT), '..')
    const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    assert.deepEqual(rootPkg.workspaces, ['packages/*'])
    const workspaceYaml = fs.readFileSync(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf8')
    assert.match(workspaceYaml, /^packages:\n\s+- ['"]packages\/\*['"]/m)
    const published = new Set(NPM_PACKAGE_FILES.map((file) => JSON.parse(fs.readFileSync(path.join(rootDir, file), 'utf8')).name))
    assert.deepEqual([...published].sort(), ['@cuttlely/chat', 'cuttlely'])
    const packageDirs = fs.readdirSync(path.join(rootDir, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    assert.ok(packageDirs.length > published.size)
    for (const entry of packageDirs) {
        const manifestPath = path.join(rootDir, 'packages', entry.name, 'package.json')
        if (!fs.existsSync(manifestPath)) continue
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        if (published.has(manifest.name)) assert.notEqual(manifest.private, true)
        else assert.equal(manifest.private, true)
    }
})

test('the release image workflow has narrow permissions, pinned actions and env-only run inputs', () => {
    const rootDir = path.resolve(path.dirname(SCRIPT), '..')
    const text = fs.readFileSync(path.join(rootDir, '.github/workflows/release-image.yml'), 'utf8')
    const permissions = /^permissions:\n((?: {4}[^\n]+\n)+)/m.exec(text)
    assert.ok(permissions)
    assert.deepEqual(
        permissions[1]
            .trim()
            .split('\n')
            .map((line) => line.trim())
            .sort(),
        ['contents: read', 'packages: write']
    )
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])
    assert.ok(uses.length > 0)
    for (const value of uses) assert.match(value, /^[^@\s]+@[0-9a-f]{40}$/)

    const lines = text.split('\n')
    const runBlocks = []
    for (let index = 0; index < lines.length; index++) {
        const start = /^(\s*)run:\s*\|\s*$/.exec(lines[index])
        if (!start) continue
        const indent = start[1].length
        const block = []
        for (index += 1; index < lines.length; index++) {
            if (!lines[index].trim()) {
                block.push(lines[index])
                continue
            }
            if (lines[index].search(/\S/) <= indent) break
            block.push(lines[index])
        }
        index -= 1
        runBlocks.push(block.join('\n'))
    }
    assert.ok(runBlocks.length > 0)
    for (const block of runBlocks) {
        assert.doesNotMatch(block, /\$\{\{\s*inputs\./)
        assert.doesNotMatch(block, /\$\{\{\s*github\.ref_name/)
    }
    assert.match(
        text,
        /platforms:\n\s+description: Build linux\/amd64; linux\/amd64,linux\/arm64 is opt-in and slow under emulation\n\s+required: false\n\s+default: linux\/amd64\n\s+type: string/
    )
    assert.match(text, /INPUT_PLATFORMS: \$\{\{ inputs\.platforms \}\}/)
    assert.match(text, /inputPlatforms: process\.env\.INPUT_PLATFORMS/)
    assert.match(text, /output\('platforms', plan\.platforms\)/)

    const checkout = text.indexOf('- uses: actions/checkout@')
    const diskStep = text.indexOf('- name: Free runner disk space')
    const setupNode = text.indexOf('- uses: actions/setup-node@')
    assert.ok(checkout >= 0 && diskStep > checkout && diskStep < setupNode)
    const diskBlock = text.slice(diskStep, setupNode)
    assert.match(
        diskBlock,
        /sudo rm -rf \/usr\/share\/dotnet \/usr\/local\/lib\/android \/opt\/ghc \/usr\/local\/\.ghcup \/opt\/hostedtoolcache\/CodeQL/
    )
    assert.match(diskBlock, /df -h \//)
    assert.doesNotMatch(diskBlock, /\$\{\{/)

    const checkBuild = text.slice(text.indexOf('- name: Build linux/amd64 release check'), text.indexOf('- name: Build and push'))
    assert.match(checkBuild, /docker\/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc/)
    assert.match(checkBuild, /platforms: linux\/amd64/)
    assert.match(checkBuild, /load: true/)
    assert.match(checkBuild, /push: false/)
    assert.match(checkBuild, /cache-from: type=gha,scope=release-image/)
    assert.doesNotMatch(checkBuild, /cache-to:/)
    assert.match(checkBuild, /provenance: false/)
    assert.match(checkBuild, /sbom: false/)
    assert.match(checkBuild, /IMAGE_TAG: cuttlely-release-check:\$\{\{ github\.run_id \}\}/)
    assert.match(checkBuild, /await checkImage\(process\.env\.IMAGE_TAG\)/)
    assert.match(checkBuild, /- name: Remove release check image/)
    assert.match(checkBuild, /docker image rm "\$IMAGE_TAG" \|\| true/)
    assert.equal(checkBuild.match(/IMAGE_TAG: cuttlely-release-check:\$\{\{ github\.run_id \}\}/g)?.length, 2)
    assert.doesNotMatch(checkBuild, /docker image rm[^\n]*\$\{\{/)
    assert.match(text, /if: contains\(steps\.plan\.outputs\.platforms, 'linux\/arm64'\)/)
    const pushBuild = text.slice(text.indexOf('- name: Build and push'), text.indexOf('- name: Inspect pushed image'))
    assert.match(pushBuild, /platforms: \$\{\{ steps\.plan\.outputs\.platforms \}\}/)
})

function manifestResponse(status, { wwwAuthenticate, body, ok } = {}) {
    return {
        status,
        ok: ok ?? (status >= 200 && status < 300),
        headers: {
            get(name) {
                if (name.toLowerCase() === 'www-authenticate') return wwwAuthenticate || null
                return null
            }
        },
        json: async () => body || {}
    }
}

test('the manifest check is anonymous and stays on ghcr.io', async () => {
    assert.equal(
        anonymousBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:cuttlely/cuttlely:pull"'),
        'https://ghcr.io/token?service=ghcr.io&scope=repository%3Acuttlely%2Fcuttlely%3Apull'
    )
    assert.equal(anonymousBearerChallenge('Bearer realm="http://ghcr.io/token"'), null)
    assert.equal(anonymousBearerChallenge('Bearer realm="https://evil.example/token"'), null)
    assert.equal(anonymousBearerChallenge(''), null)

    const urls = []
    const present = await anonymousManifestExists('1.0.1', async (url) => {
        urls.push(String(url))
        return manifestResponse(200)
    })
    assert.deepEqual(present, { ok: true, error: false })
    assert.equal(urls[0], 'https://ghcr.io/v2/cuttlely/cuttlely/manifests/1.0.1')

    const missing = await anonymousManifestExists('9.9.9', async () => manifestResponse(404))
    assert.deepEqual(missing, { ok: false, error: false })

    const challenged = []
    const authed = await anonymousManifestExists('1.0.1', async (url, init) => {
        challenged.push({ url: String(url), auth: init?.headers?.Authorization || '' })
        if (String(url).includes('/manifests/') && !init?.headers?.Authorization) {
            return manifestResponse(401, {
                wwwAuthenticate: 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:cuttlely/cuttlely:pull"'
            })
        }
        if (String(url).startsWith('https://ghcr.io/token')) return manifestResponse(200, { body: { token: 'anon-registry-token' } })
        return manifestResponse(200)
    })
    assert.deepEqual(authed, { ok: true, error: false })
    assert.equal(challenged[1].url, 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Acuttlely%2Fcuttlely%3Apull')
    assert.equal(challenged[2].auth, 'Bearer anon-registry-token')
    assert.ok(challenged.every((call) => call.url.startsWith('https://ghcr.io/')))

    const evil = await anonymousManifestExists('1.0.1', async (url) => {
        if (String(url).includes('/manifests/'))
            return manifestResponse(401, { wwwAuthenticate: 'Bearer realm="https://evil.example/token"' })
        throw new Error(`must not fetch ${url}`)
    })
    assert.deepEqual(evil, { ok: false, error: true })

    const down = await anonymousManifestExists('1.0.1', async () => {
        throw new Error('offline')
    })
    assert.deepEqual(down, { ok: false, error: true })
})

test('the workflow wait succeeds after an in-progress poll and confirms the manifest', async () => {
    let clock = 0
    let runAttempts = 0
    let manifestAttempts = 0
    const lines = []
    await waitForRegistryImage(
        { image: 'ghcr.io/cuttlely/cuttlely', version: '1.5.3', sha: 'release-sha' },
        {
            runner: (cmd, args, options) => {
                runAttempts += 1
                assert.equal(cmd, 'gh')
                assert.deepEqual(args, [
                    'run',
                    'list',
                    '--workflow',
                    'release-image.yml',
                    '--event',
                    'push',
                    '--commit',
                    'release-sha',
                    '--json',
                    'databaseId,status,conclusion,headBranch,url'
                ])
                assert.equal(options.allowFail, true)
                return {
                    status: 0,
                    stdout: JSON.stringify([
                        {
                            databaseId: 1,
                            status: runAttempts === 1 ? 'in_progress' : 'completed',
                            conclusion: runAttempts === 1 ? null : 'success',
                            headBranch: 'v1.5.3',
                            url: 'https://github.com/cuttlely/cuttlely/actions/runs/1'
                        }
                    ])
                }
            },
            fetchImpl: async () => {
                manifestAttempts += 1
                return manifestResponse(200)
            },
            timeoutMs: 50,
            pollMs: 5,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms
            },
            log: (line) => lines.push(line)
        }
    )
    assert.equal(runAttempts, 2)
    assert.equal(manifestAttempts, 1)
    assert.match(lines.join('\n'), /Still waiting/)
    assert.match(lines.join('\n'), /run passed.*is available/)
})

test('a completed unsuccessful workflow run names its URL and the resume command', async () => {
    await assert.rejects(
        waitForRegistryImage(
            {
                image: 'ghcr.io/cuttlely/cuttlely',
                version: '1.5.3',
                sha: 'release-sha',
                resumeCommand: 'pnpm release 1.5.3 --publish'
            },
            {
                runner: () => ({
                    status: 0,
                    stdout: JSON.stringify([
                        {
                            databaseId: 2,
                            status: 'completed',
                            conclusion: 'failure',
                            headBranch: 'v1.5.3',
                            url: 'https://github.com/cuttlely/cuttlely/actions/runs/2'
                        }
                    ])
                }),
                fetchImpl: async () => {
                    throw new Error('the manifest must not be checked')
                },
                log: () => {}
            }
        ),
        (error) => {
            assert.ok(error instanceof ReleaseError)
            assert.match(error.message, /https:\/\/github\.com\/cuttlely\/cuttlely\/actions\/runs\/2/)
            assert.match(error.message, /pnpm release 1\.5\.3 --publish/)
            return true
        }
    )
})

test('a workflow run for another tag is ignored', async () => {
    let clock = 0
    let runAttempts = 0
    let manifestAttempts = 0
    await waitForRegistryImage(
        { image: 'ghcr.io/cuttlely/cuttlely', version: '1.5.3', sha: 'release-sha' },
        {
            runner: () => {
                runAttempts += 1
                return {
                    status: 0,
                    stdout: JSON.stringify([
                        {
                            databaseId: runAttempts,
                            status: 'completed',
                            conclusion: 'success',
                            headBranch: runAttempts === 1 ? 'v1.5.2' : 'v1.5.3',
                            url: `https://github.com/cuttlely/cuttlely/actions/runs/${runAttempts}`
                        }
                    ])
                }
            },
            fetchImpl: async () => {
                manifestAttempts += 1
                return manifestResponse(200)
            },
            timeoutMs: 20,
            pollMs: 5,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms
            },
            log: () => {}
        }
    )
    assert.equal(runAttempts, 2)
    assert.equal(manifestAttempts, 1)
})

test('an existing manifest alone does not end the bounded workflow wait', async () => {
    let clock = 0
    let manifestAttempts = 0

    await assert.rejects(
        waitForRegistryImage(
            {
                image: 'ghcr.io/cuttlely/cuttlely',
                version: '1.5.3',
                sha: 'release-sha',
                resumeCommand: 'pnpm release 1.5.3 --publish'
            },
            {
                runner: () => ({
                    status: 0,
                    stdout: JSON.stringify([
                        {
                            databaseId: 3,
                            status: 'in_progress',
                            conclusion: null,
                            headBranch: 'v1.5.3',
                            url: 'https://github.com/cuttlely/cuttlely/actions/runs/3'
                        }
                    ])
                }),
                fetchImpl: async () => {
                    manifestAttempts += 1
                    return manifestResponse(200)
                },
                timeoutMs: 10,
                pollMs: 5,
                now: () => clock,
                sleep: async (ms) => {
                    clock += ms
                },
                log: () => {}
            }
        ),
        /release-image\.yml.*pnpm release 1\.5\.3 --publish/
    )
    assert.equal(manifestAttempts, 0)
})

test('npm publish problems name every refusal and never the token', () => {
    const ready = {
        version: '1.0.1',
        dirty: [],
        tagExists: true,
        tagAnnotated: true,
        head: 'abc1234',
        tagCommit: 'abc1234',
        versions: VERSION_FILES.map((file) => ({ file, version: '1.0.1' })),
        imageExists: true,
        imageError: false,
        githubRelease: 'published',
        npmToken: true
    }
    assert.deepEqual(npmPublishProblems(ready), [])
    const cases = [
        [{ ...ready, dirty: ['?? stray.txt'] }, 'not clean'],
        [{ ...ready, tagExists: false, tagAnnotated: false }, 'does not exist'],
        [{ ...ready, tagAnnotated: false }, 'not an annotated tag'],
        [{ ...ready, head: 'fff0000' }, 'not the annotated tag'],
        [
            {
                ...ready,
                versions: ready.versions.map((item) => (item.file === 'packages/cli/package.json' ? { ...item, version: '1.0.0' } : item))
            },
            'packages/cli/package.json is 1.0.0'
        ],
        [
            {
                ...ready,
                versions: ready.versions.map((item) =>
                    item.file === 'packages/chat-widget/package.json' ? { ...item, version: '9.9.9' } : item
                )
            },
            'packages/chat-widget/package.json is 9.9.9'
        ],
        [{ ...ready, imageExists: false }, 'not in the registry'],
        [{ ...ready, imageExists: false, imageError: true }, 'Could not check the image'],
        [{ ...ready, githubRelease: 'draft' }, 'still a draft'],
        [{ ...ready, githubRelease: 'missing' }, 'is not published'],
        [{ ...ready, npmToken: false }, 'NPM_TOKEN is not set']
    ]
    for (const [state, needle] of cases) {
        const problems = npmPublishProblems(state)
        assert.ok(
            problems.some((problem) => problem.includes(needle)),
            needle
        )
        assert.equal(problems.join('\n').includes('secret-token'), false)
    }
    const combined = npmPublishProblems({
        ...ready,
        dirty: ['?? stray.txt'],
        imageExists: false,
        githubRelease: 'draft',
        npmToken: false,
        versions: ready.versions.map((item) => (item.file === 'package.json' ? { ...item, version: '0.0.0' } : item))
    })
    for (const needle of ['not clean', 'package.json is 0.0.0', 'not in the registry', 'still a draft', 'NPM_TOKEN is not set']) {
        assert.ok(
            combined.some((problem) => problem.includes(needle)),
            needle
        )
    }
})

const NPM_TOKEN = 'npm-test-token-do-not-print'

function gitResult(cwd, args) {
    const res = testGit(cwd, args, { tmpRoot: path.dirname(cwd) })
    return { status: res.status ?? 1, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() }
}

function npmCheckout({ version = '1.0.0', annotate = true, lightweight = false, ahead = false, dirty = false, versions = {} } = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-npm-release-')))
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const runGit = (args) => {
        const res = testGit(repo, args, { tmpRoot: dir })
        if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
        return (res.stdout || '').trim()
    }
    runGit(['init', '-q', '-b', 'main'])
    for (const [key, value] of [
        ['user.name', 'Release Test'],
        ['user.email', 'release-test@example.invalid'],
        ['commit.gpgsign', 'false'],
        ['tag.gpgsign', 'false']
    ]) {
        runGit(['config', key, value])
    }
    const files = {
        'package.json': 'cuttlely-workspace',
        'packages/server/package.json': 'server',
        'packages/cli/package.json': 'cuttlely',
        'packages/chat-widget/package.json': '@cuttlely/chat'
    }
    for (const [file, name] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
        const pkgVersion = versions[file] || version
        fs.writeFileSync(path.join(repo, file), `{\n    "name": "${name}",\n    "version": "${pkgVersion}"\n}\n`)
    }
    runGit(['add', '.'])
    runGit(['commit', '-q', '-m', 'init'])
    if (annotate) runGit(['tag', '-a', `v${version}`, '-m', `Cuttlely ${version}`])
    else if (lightweight) runGit(['tag', `v${version}`])
    if (ahead) runGit(['commit', '-q', '--allow-empty', '-m', 'later'])
    if (dirty) fs.writeFileSync(path.join(repo, 'stray.txt'), 'x\n')
    return {
        repo,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
    }
}

function fakeManifest(status) {
    return async () => manifestResponse(status)
}

async function runNpm(
    repo,
    args,
    { manifestStatus = 200, github = 'false', token = NPM_TOKEN, npmStatus = 0, packStatus = 0, buildStatus = 0, onNpm = [] } = {}
) {
    const lines = []
    const calls = []
    let userconfig = null
    let userconfigMode = null
    let userconfigMatched = false
    try {
        const code = await main(args, repo, {
            log: (line = '') => lines.push(line),
            env: token == null ? {} : { NPM_TOKEN: token },
            fetch: fakeManifest(manifestStatus),
            run(cmd, cmdArgs, opts = {}) {
                if (cmd === 'git') return gitResult(opts.cwd, cmdArgs)
                calls.push({ cmd, args: cmdArgs, cwd: opts.cwd })
                if (cmd === 'gh') {
                    if (github === 'missing') return { status: 1, stdout: '', stderr: 'release not found' }
                    return { status: 0, stdout: github, stderr: '' }
                }
                if (cmd === 'pnpm') return { status: buildStatus, stdout: '', stderr: buildStatus === 0 ? '' : 'build failed' }
                if (cmd === 'npm' && cmdArgs[0] === 'view') {
                    const spec = cmdArgs[1]
                    if (onNpm.includes(spec)) return { status: 0, stdout: spec.slice(spec.lastIndexOf('@') + 1), stderr: '' }
                    return { status: 1, stdout: '', stderr: 'npm error code E404' }
                }
                if (cmd === 'npm' && cmdArgs[0] === 'pack')
                    return { status: packStatus, stdout: '', stderr: packStatus === 0 ? '' : 'pack failed' }
                if (cmd === 'npm' && cmdArgs[0] === 'publish') {
                    userconfig = cmdArgs[cmdArgs.indexOf('--userconfig') + 1]
                    const text = fs.readFileSync(userconfig, 'utf8')
                    userconfigMode = fs.statSync(userconfig).mode & 0o777
                    userconfigMatched = text === `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n` && !text.includes('\n\n')
                    return { status: npmStatus, stdout: '', stderr: npmStatus === 0 ? '' : `denied ${NPM_TOKEN}` }
                }
                return { status: 1, stdout: '', stderr: `unexpected ${cmd}` }
            }
        })
        return { code, out: lines.join('\n'), calls, userconfig, userconfigMode, userconfigMatched }
    } catch (error) {
        error.out = lines.join('\n')
        error.calls = calls
        error.userconfig = userconfig
        throw error
    }
}

test('npm publish refuses each failed check and does not publish', async (t) => {
    const published = npmCheckout()
    t.after(() => {
        published.cleanup()
    })

    const noTag = npmCheckout({ annotate: false })
    t.after(() => noTag.cleanup())
    let res = await runNpm(noTag.repo, ['1.0.0', '--npm'])
    assert.equal(res.code, 1)
    assert.match(res.out, /Tag v1\.0\.0 does not exist/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    const light = npmCheckout({ annotate: false, lightweight: true })
    t.after(() => light.cleanup())
    res = await runNpm(light.repo, ['1.0.0', '--npm'])
    assert.equal(res.code, 1)
    assert.match(res.out, /not an annotated tag/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    const ahead = npmCheckout({ ahead: true })
    t.after(() => ahead.cleanup())
    res = await runNpm(ahead.repo, ['1.0.0', '--npm'])
    assert.equal(res.code, 1)
    assert.match(res.out, /not the annotated tag v1\.0\.0/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    const dirty = npmCheckout({ dirty: true })
    t.after(() => dirty.cleanup())
    res = await runNpm(dirty.repo, ['1.0.0', '--npm', '--dry-run'])
    assert.equal(res.code, 1)
    assert.match(res.out, /not clean/)
    assert.match(res.out, /A real run would refuse/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm' || call.cmd === 'pnpm'),
        false
    )

    const cliVersion = npmCheckout({ versions: { 'packages/cli/package.json': '0.9.0' } })
    t.after(() => cliVersion.cleanup())
    res = await runNpm(cliVersion.repo, ['1.0.0', '--npm'])
    assert.equal(res.code, 1)
    assert.match(res.out, /packages\/cli\/package\.json is 0\.9\.0/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    const widgetVersion = npmCheckout({ versions: { 'packages/chat-widget/package.json': '0.9.0' } })
    t.after(() => widgetVersion.cleanup())
    res = await runNpm(widgetVersion.repo, ['1.0.0', '--npm'])
    assert.equal(res.code, 1)
    assert.match(res.out, /packages\/chat-widget\/package\.json is 0\.9\.0/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    res = await runNpm(published.repo, ['1.0.0', '--npm'], { manifestStatus: 404 })
    assert.equal(res.code, 1)
    assert.match(res.out, /ghcr\.io\/cuttlely\/cuttlely:1\.0\.0 is not in the registry/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    res = await runNpm(published.repo, ['1.0.0', '--npm'], { manifestStatus: 500 })
    assert.equal(res.code, 1)
    assert.match(res.out, /Could not check the image/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    res = await runNpm(published.repo, ['1.0.0', '--npm'], { github: 'true' })
    assert.equal(res.code, 1)
    assert.match(res.out, /still a draft/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    res = await runNpm(published.repo, ['1.0.0', '--npm'], { github: 'missing' })
    assert.equal(res.code, 1)
    assert.match(res.out, /is not published/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    res = await runNpm(published.repo, ['1.0.0', '--npm'], { token: null })
    assert.equal(res.code, 1)
    assert.match(res.out, /NPM_TOKEN is not set/)
    assert.equal(res.out.includes(NPM_TOKEN), false)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )

    res = await runNpm(published.repo, ['1.0.0', '--npm'], { token: '   ' })
    assert.equal(res.code, 1)
    assert.match(res.out, /NPM_TOKEN is not set/)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm'),
        false
    )
})

test('npm dry run passes the checks and does not pack or publish', async (t) => {
    const repo = npmCheckout()
    t.after(() => repo.cleanup())
    const res = await runNpm(repo.repo, ['1.0.0', '--npm', '--dry-run'])
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /npm publish \.\/packages\/cli/)
    assert.match(res.out, /npm publish \.\/packages\/chat-widget/)
    assert.match(res.out, /npm pack --dry-run \(packages\/cli\)/)
    assert.match(res.out, /pnpm --dir packages\/chat-widget build/)
    assert.match(res.out, /Dry run passed/)
    assert.equal(res.out.includes(NPM_TOKEN), false)
    assert.equal(
        res.calls.some((call) => call.cmd === 'npm' || call.cmd === 'pnpm'),
        false
    )
    assert.ok(res.calls.some((call) => call.cmd === 'gh'))
})

test('npm publish builds, pack-checks and publishes both packages without printing the token', async (t) => {
    const repo = npmCheckout()
    t.after(() => repo.cleanup())
    const res = await runNpm(repo.repo, ['1.0.0', '--npm'])
    assert.equal(res.code, 0, res.out)
    assert.equal(res.out.includes(NPM_TOKEN), false)
    assert.equal(res.userconfigMatched, true)
    assert.equal(res.userconfigMode, 0o600)
    assert.equal(fs.existsSync(res.userconfig), false)
    const npmCalls = res.calls.filter((call) => call.cmd === 'npm')
    assert.deepEqual(
        npmCalls.map((call) => call.args[0]),
        ['pack', 'pack', 'view', 'publish', 'view', 'publish']
    )
    assert.equal(npmCalls[0].cwd.endsWith(`${path.sep}packages${path.sep}cli`), true)
    assert.equal(npmCalls[1].cwd.endsWith(`${path.sep}packages${path.sep}chat-widget`), true)
    assert.deepEqual(npmCalls[2].args.slice(0, 2), ['view', 'cuttlely@1.0.0'])
    assert.deepEqual(npmCalls[3].args.slice(0, 2), ['publish', './packages/cli'])
    assert.deepEqual(npmCalls[4].args.slice(0, 2), ['view', '@cuttlely/chat@1.0.0'])
    assert.deepEqual(npmCalls[5].args.slice(0, 2), ['publish', './packages/chat-widget'])
    assert.ok(res.calls.some((call) => call.cmd === 'pnpm' && call.args.includes('build')))
})

test('a failed widget build or pack does not publish, and a failed publish redacts the token', async (t) => {
    const repo = npmCheckout()
    t.after(() => repo.cleanup())
    await assert.rejects(runNpm(repo.repo, ['1.0.0', '--npm'], { buildStatus: 1 }), (error) => {
        assert.match(error.message, /build failed/)
        assert.equal(
            error.calls.some((call) => call.cmd === 'npm'),
            false
        )
        return true
    })
    await assert.rejects(runNpm(repo.repo, ['1.0.0', '--npm'], { packStatus: 1 }), (error) => {
        assert.match(error.message, /pack failed/)
        assert.equal(
            error.calls.some((call) => call.cmd === 'npm' && call.args[0] === 'publish'),
            false
        )
        return true
    })
    await assert.rejects(runNpm(repo.repo, ['1.0.0', '--npm'], { npmStatus: 1 }), (error) => {
        assert.match(error.message, /NPM_TOKEN/)
        assert.equal(error.message.includes(NPM_TOKEN), false)
        assert.equal(error.out.includes(NPM_TOKEN), false)
        assert.equal(fs.existsSync(error.userconfig), false)
        assert.equal(error.calls.filter((call) => call.cmd === 'npm' && call.args[0] === 'publish').length, 1)
        return true
    })
})

test('a resumed npm publish skips a package version npm already has', async (t) => {
    const repo = npmCheckout()
    t.after(() => repo.cleanup())
    const res = await runNpm(repo.repo, ['1.0.0', '--npm'], { onNpm: ['cuttlely@1.0.0'] })
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /cuttlely@1\.0\.0 is already on npm, skipped/)
    assert.equal(res.out.includes(NPM_TOKEN), false)
    const publishes = res.calls.filter((call) => call.cmd === 'npm' && call.args[0] === 'publish')
    assert.deepEqual(
        publishes.map((call) => call.args[1]),
        ['./packages/chat-widget']
    )
    assert.equal(fs.existsSync(res.userconfig), false)
})
