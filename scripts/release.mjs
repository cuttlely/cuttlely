#!/usr/bin/env node
// Cut a Cuttlely release from a maintainer machine. GitHub Actions does not run releases.
//
//   pnpm release [X.Y.Z | major | minor | patch] [--dry-run] [--local] [--push] [--publish] [--npm]
//
// With no version, the version comes from a "## [X.Y.Z] - Unreleased" heading in CHANGELOG.md.
//
//   --dry-run   change nothing: run the checks, print the plan and the release notes
//   (no flag)   verify, bump, update CHANGELOG, commit, tag, build and check the image locally,
//               push the release commit and tag, and create a draft GitHub release
//   --local     stop before anything leaves this machine: no git push and no draft release
//   --push      also push the image to the registry (multi-arch when buildx can build arm64)
//   --publish   publish the GitHub release instead of leaving a draft (needs the image in the registry)
//   --npm       publish the npm packages from the annotated tag, after the image and GitHub release exist
//
// Other options: --image <name> (default ghcr.io/<owner>/<repo>), --skip-image-check (skip the
// start-and-ping check of the local image), --help.
//
// A run that stopped part way can be started again with the same version: a release commit that
// is already tagged is reused, and steps that are already done are skipped.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VERSION_FILES = [
    'package.json',
    'packages/server/package.json',
    'packages/cli/package.json',
    'packages/chat-widget/package.json'
]

// The two packages `pnpm release X.Y.Z --npm` publishes. Their versions stay in VERSION_FILES.
export const NPM_PACKAGE_FILES = ['packages/cli/package.json', 'packages/chat-widget/package.json']
export const NPM_IMAGE = 'ghcr.io/cuttlely/cuttlely'
const MANIFEST_ACCEPT = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json'
].join(', ')

export function npmImageRef(version) {
    return `${NPM_IMAGE}:${version}`
}

export function formatList(items) {
    if (items.length <= 1) return items.join('')
    if (items.length === 2) return `${items[0]} and ${items[1]}`
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}
export const CHANGELOG = 'CHANGELOG.md'
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const HEADING = /^## \[([^\]]+)\](?: - (.+))?\s*$/
const PING_TIMEOUT_MS = 6 * 60 * 1000

export class ReleaseError extends Error {}

// ---------- pure helpers (tested in scripts/release.test.mjs) ----------

export function parseArgs(argv) {
    const opts = {
        version: null,
        dryRun: false,
        local: false,
        push: false,
        publish: false,
        npm: false,
        image: null,
        skipImageCheck: false,
        help: false
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--dry-run') opts.dryRun = true
        else if (arg === '--local') opts.local = true
        else if (arg === '--push') opts.push = true
        else if (arg === '--publish') opts.publish = true
        else if (arg === '--npm') opts.npm = true
        else if (arg === '--skip-image-check') opts.skipImageCheck = true
        else if (arg === '--help' || arg === '-h') opts.help = true
        else if (arg === '--image') {
            const value = argv[++i]
            if (!value || value.startsWith('--'))
                throw new ReleaseError('--image needs a value, for example --image ghcr.io/owner/cuttlely')
            opts.image = value
        } else if (arg.startsWith('--image=')) opts.image = arg.slice('--image='.length)
        else if (arg.startsWith('-')) throw new ReleaseError(`Unknown option ${arg}. Run pnpm release --help.`)
        else if (opts.version) throw new ReleaseError(`Give one version, not ${opts.version} and ${arg}.`)
        else opts.version = arg.replace(/^v(?=\d)/, '')
    }
    if (opts.local && (opts.push || opts.publish))
        throw new ReleaseError('--local keeps everything on this machine, so it cannot be used with --push or --publish.')
    if (opts.npm && (opts.local || opts.push || opts.publish))
        throw new ReleaseError('--npm publishes the npm packages from the tagged release. Run it on its own: pnpm release X.Y.Z --npm.')
    if (opts.npm && !opts.version) throw new ReleaseError('--npm needs a version: pnpm release X.Y.Z --npm.')
    if (opts.npm && !parseSemver(opts.version)) throw new ReleaseError(`--npm needs an exact version (X.Y.Z), not ${opts.version}.`)
    return opts
}

export function parseSemver(version) {
    const m = SEMVER.exec(String(version))
    if (!m) return null
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || null }
}

export function compareSemver(a, b) {
    const x = parseSemver(a)
    const y = parseSemver(b)
    if (!x || !y) throw new ReleaseError(`Not a version: ${!x ? a : b}`)
    for (const key of ['major', 'minor', 'patch']) {
        if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1
    }
    if (x.pre === y.pre) return 0
    if (!x.pre) return 1
    if (!y.pre) return -1
    const xs = x.pre.split('.')
    const ys = y.pre.split('.')
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
        if (xs[i] === undefined) return -1
        if (ys[i] === undefined) return 1
        const xn = /^\d+$/.test(xs[i])
        const yn = /^\d+$/.test(ys[i])
        if (xn && yn && Number(xs[i]) !== Number(ys[i])) return Number(xs[i]) < Number(ys[i]) ? -1 : 1
        if (xn !== yn) return xn ? -1 : 1
        if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1
    }
    return 0
}

export function bumpVersion(current, kind) {
    const v = parseSemver(current)
    if (!v) throw new ReleaseError(`The current version ${current} is not a version.`)
    if (kind === 'major') return `${v.major + 1}.0.0`
    if (kind === 'minor') return `${v.major}.${v.minor + 1}.0`
    if (kind === 'patch') return v.pre ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`
    throw new ReleaseError(`Unknown bump ${kind}`)
}

export function isPrerelease(version) {
    return Boolean(parseSemver(version)?.pre)
}

// Replace only the top-level "version" value, so the rest of the file keeps its formatting.
export function setPackageVersion(text, version) {
    if (typeof JSON.parse(text).version !== 'string') throw new ReleaseError('No top-level "version" field found.')
    const indent = /^\{\s*?\n([ \t]+)"/.exec(text)?.[1]
    if (!indent) throw new ReleaseError('Could not read the indentation of the package file.')
    const field = new RegExp(`^${indent}"version"(\\s*:\\s*)"[^"]*"`, 'm')
    if (!field.test(text)) throw new ReleaseError('No top-level "version" field found.')
    return text.replace(field, (_, sep) => `${indent}"version"${sep}"${version}"`)
}

export function readPackageVersion(text) {
    const parsed = JSON.parse(text)
    return typeof parsed.version === 'string' ? parsed.version : null
}

export function changelogSections(text) {
    const lines = text.split('\n')
    const sections = []
    for (let i = 0; i < lines.length; i++) {
        const m = HEADING.exec(lines[i])
        if (m) sections.push({ line: i, name: m[1], label: m[2] ? m[2].trim() : null })
    }
    for (let s = 0; s < sections.length; s++) {
        let end = s + 1 < sections.length ? sections[s + 1].line : lines.length
        for (let i = sections[s].line + 1; i < end; i++) {
            if (/^\[[^\]]+\]:\s/.test(lines[i])) {
                end = i
                break
            }
        }
        sections[s].end = end
        sections[s].body = lines
            .slice(sections[s].line + 1, end)
            .join('\n')
            .trim()
    }
    return sections
}

// The version to release when none is given: a planned "## [X.Y.Z] - Unreleased" heading.
export function plannedVersion(text) {
    const planned = changelogSections(text).filter((s) => parseSemver(s.name) && s.label && /^unreleased$/i.test(s.label))
    if (planned.length > 1) throw new ReleaseError(`CHANGELOG.md plans more than one version: ${planned.map((s) => s.name).join(', ')}.`)
    return planned[0]?.name ?? null
}

function isEmptyBody(body) {
    let text = body
    let previous
    // Removing one comment can join the text around it into another, so repeat until nothing changes.
    do {
        previous = text
        text = text.replace(/<!--[\s\S]*?-->/g, '')
    } while (text !== previous)
    return text.replace(/^nothing yet\.?$/gim, '').trim() === ''
}

// Pick the section that becomes the release: "## [X.Y.Z] - Unreleased", or "## [Unreleased]".
export function releaseSection(text, version) {
    const sections = changelogSections(text)
    if (sections.some((s) => s.name === version && !(s.label && /^unreleased$/i.test(s.label)))) {
        throw new ReleaseError(`CHANGELOG.md already has a dated ${version} section.`)
    }
    const planned = sections.find((s) => s.name === version)
    const unreleased = sections.find((s) => /^unreleased$/i.test(s.name))
    if (planned) {
        if (unreleased && !isEmptyBody(unreleased.body)) {
            throw new ReleaseError(
                `CHANGELOG.md has entries under both [Unreleased] and [${version}] - Unreleased. Move them into one section first.`
            )
        }
        if (isEmptyBody(planned.body)) throw new ReleaseError(`The [${version}] section in CHANGELOG.md is empty.`)
        return { section: planned, kind: 'planned' }
    }
    if (unreleased && !isEmptyBody(unreleased.body)) return { section: unreleased, kind: 'unreleased' }
    throw new ReleaseError(`CHANGELOG.md has nothing to release for ${version}. Add entries under "## [Unreleased]" first.`)
}

export function repoUrl(slug) {
    return `https://github.com/${slug}`
}

// Date the release section, open a fresh [Unreleased], and rewrite the two compare links.
export function updateChangelog(text, { version, date, slug, previousTag }) {
    const { section, kind } = releaseSection(text, version)
    const lines = text.split('\n')
    const drop = new Set()
    if (kind === 'planned') {
        // An empty [Unreleased] above a planned version is replaced by the fresh one.
        for (const s of changelogSections(text)) {
            if (/^unreleased$/i.test(s.name) && isEmptyBody(s.body)) for (let i = s.line; i < s.end; i++) drop.add(i)
        }
    }
    const out = []
    for (let i = 0; i < lines.length; i++) {
        if (drop.has(i)) continue
        if (i === section.line) {
            out.push('## [Unreleased]', '', `## [${version}] - ${date}`)
            continue
        }
        out.push(lines[i])
    }
    const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const isOwnLink = (line) => new RegExp(`^\\[(unreleased|${escape(version)})\\]:\\s`, 'i').test(line)
    const kept = out.filter((line) => !isOwnLink(line))
    const url = repoUrl(slug)
    const versionLink = previousTag ? `${url}/compare/${previousTag}...v${version}` : `${url}/releases/tag/v${version}`
    const links = [`[Unreleased]: ${url}/compare/v${version}...HEAD`, `[${version}]: ${versionLink}`]
    const firstLink = kept.findIndex((l) => /^\[[^\]]+\]:\s/.test(l))
    if (firstLink === -1) {
        while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
        kept.push('', ...links)
    } else {
        kept.splice(firstLink, 0, ...links)
    }
    return `${kept
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n*$/, '')}\n`
}

// Release notes: the section body, plus where to get the image.
// Relative links in CHANGELOG.md point into the repository; a release page needs them absolute.
export function absoluteLinks(markdown, slug, ref) {
    if (!slug) return markdown
    return markdown.replace(/\]\((?:\.\/)?((?!https?:|mailto:|#)[^)\s]+)\)/g, (_, target) => `](${repoUrl(slug)}/blob/${ref}/${target})`)
}

export function releaseNotes(text, version, { image, slug } = {}) {
    const section = changelogSections(text).find((s) => s.name === version)
    if (!section) throw new ReleaseError(`CHANGELOG.md has no ${version} section.`)
    const parts = [absoluteLinks(section.body.trim(), slug, `v${version}`)]
    if (image) {
        parts.push(['### Docker image', '', '```', `docker pull ${image}:${version}`, '```'].join('\n'))
    }
    return `${parts.join('\n\n')}\n`
}

export function slugFromRemote(url) {
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim())
    return m ? `${m[1]}/${m[2]}` : null
}

export function defaultImage(slug) {
    return `ghcr.io/${slug.toLowerCase()}`
}

export function imageTags(image, version) {
    return isPrerelease(version) ? [`${image}:${version}`] : [`${image}:${version}`, `${image}:latest`]
}

export function imageLabels({ version, sha, slug, created }) {
    return {
        'org.opencontainers.image.title': 'cuttlely',
        'org.opencontainers.image.description': 'Build, run and improve AI applications on infrastructure you control.',
        'org.opencontainers.image.version': version,
        'org.opencontainers.image.revision': sha,
        'org.opencontainers.image.source': repoUrl(slug),
        'org.opencontainers.image.licenses': 'Apache-2.0',
        'org.opencontainers.image.created': created
    }
}

// The current buildx builder, from `docker buildx inspect --bootstrap`.
export function buildxInfo(inspectOutput) {
    const platforms = new Set()
    let driver = null
    for (const line of String(inspectOutput).split('\n')) {
        const d = /^\s*Driver:\s*(\S+)/.exec(line)
        if (d && !driver) driver = d[1]
        const m = /^\s*Platforms:\s*(.+)$/.exec(line)
        if (!m) continue
        for (const p of m[1].split(',')) platforms.add(p.trim().replace(/\*$/, ''))
    }
    return { driver, platforms: [...platforms] }
}

// The plain docker driver cannot build a multi-platform image; a docker-container builder can.
export function canBuildMultiArch({ driver, platforms }) {
    return driver !== null && driver !== 'docker' && platforms.includes('linux/amd64') && platforms.includes('linux/arm64')
}

// The docker commands for the local image and for the push, as argument lists.
export function dockerPlan({ image, version, sha, slug, created, multiArch, push }) {
    const tags = imageTags(image, version)
    const labelArgs = Object.entries(imageLabels({ version, sha, slug, created })).flatMap(([k, v]) => ['--label', `${k}=${v}`])
    const tagArgs = tags.flatMap((t) => ['-t', t])
    const local = ['build', '--platform', 'linux/amd64', ...tagArgs, ...labelArgs, '.']
    let pushCommands = []
    if (push) {
        pushCommands = multiArch
            ? [['buildx', 'build', '--platform', 'linux/amd64,linux/arm64', ...tagArgs, ...labelArgs, '--push', '.']]
            : tags.map((t) => ['push', t])
    }
    return { tags, local, push: pushCommands }
}

// Preflight: every reason to refuse, in one list.
export function preflightProblems(state) {
    const problems = []
    if (state.dirty.length)
        problems.push(
            `The working tree is not clean (${state.dirty.length} changed or untracked path(s), first: ${state.dirty[0]}). Commit or remove them.`
        )
    if (state.branch !== 'main') problems.push(`Releases are cut from main. This checkout is on ${state.branch || 'a detached HEAD'}.`)
    if (!state.resume && state.head !== state.originMain)
        problems.push(
            `main is not in sync with origin/main (${short(state.head)} here, ${short(state.originMain)} on origin). Pull or push first.`
        )
    if (state.resume && state.resume.parent !== state.originMain && state.head !== state.originMain) {
        problems.push(`The release commit ${short(state.head)} does not sit on origin/main (${short(state.originMain)}).`)
    }
    if (state.versionMismatch) problems.push(state.versionMismatch)
    if (!state.resume) {
        if (state.localTag) problems.push(`Tag v${state.version} already exists here.`)
        if (state.remoteTag) problems.push(`Tag v${state.version} already exists on origin.`)
        if (state.latestTag && compareSemver(state.version, state.latestTag.replace(/^v/, '')) <= 0) {
            problems.push(`${state.version} is not newer than the latest tag ${state.latestTag}.`)
        }
        if (compareSemver(state.version, state.currentVersion) < 0)
            problems.push(`${state.version} is older than the current version ${state.currentVersion}.`)
        if (state.changelogProblem) problems.push(state.changelogProblem)
    }
    if (!state.docker) problems.push('docker was not found. The release builds the image.')
    if (!state.local && !state.gh) problems.push('gh is not installed or not signed in (gh auth status). It creates the GitHub release.')
    if (state.publish && !state.push && !state.imageInRegistry)
        problems.push(`--publish needs the image in the registry. Add --push, or push ${state.image}:${state.version} first.`)
    return problems
}

// The registry token URL from a Bearer challenge. Only https://ghcr.io is accepted.
export function anonymousBearerChallenge(header) {
    if (!header) return null
    const realm = /realm="([^"]+)"/.exec(header)
    if (!realm) return null
    let url
    try {
        url = new URL(realm[1])
    } catch {
        return null
    }
    if (url.protocol !== 'https:' || url.hostname !== 'ghcr.io') return null
    const service = /service="([^"]+)"/.exec(header)
    const scope = /scope="([^"]+)"/.exec(header)
    if (service) url.searchParams.set('service', service[1])
    if (scope) url.searchParams.set('scope', scope[1])
    return url.toString()
}

function responseHeader(res, name) {
    const headers = res && res.headers
    if (!headers) return null
    if (typeof headers.get === 'function') return headers.get(name)
    const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
    return found ? headers[found] : null
}

// Anonymous manifest check for ghcr.io/cuttlely/cuttlely:version. No registry credentials.
export async function anonymousManifestExists(version, fetchImpl = globalThis.fetch) {
    const manifestUrl = `https://ghcr.io/v2/cuttlely/cuttlely/manifests/${encodeURIComponent(version)}`
    const headers = { Accept: MANIFEST_ACCEPT }
    let res
    try {
        res = await fetchImpl(manifestUrl, { headers, redirect: 'manual' })
    } catch {
        return { ok: false, error: true }
    }
    if (res.status === 401) {
        const challenge = anonymousBearerChallenge(responseHeader(res, 'www-authenticate'))
        if (!challenge) return { ok: false, error: true }
        let tokenRes
        try {
            tokenRes = await fetchImpl(challenge, { redirect: 'manual' })
        } catch {
            return { ok: false, error: true }
        }
        if (!tokenRes.ok) return { ok: false, error: true }
        let body
        try {
            body = await tokenRes.json()
        } catch {
            return { ok: false, error: true }
        }
        const registryToken =
            body && typeof body.token === 'string' ? body.token : body && typeof body.access_token === 'string' ? body.access_token : null
        if (!registryToken) return { ok: false, error: true }
        try {
            res = await fetchImpl(manifestUrl, {
                headers: { ...headers, Authorization: `Bearer ${registryToken}` },
                redirect: 'manual'
            })
        } catch {
            return { ok: false, error: true }
        }
    }
    if (res.status === 200) return { ok: true, error: false }
    if (res.status === 404) return { ok: false, error: false }
    return { ok: false, error: true }
}

export function npmTokenValue(env) {
    const value = env && env.NPM_TOKEN
    if (typeof value !== 'string' || value.trim() === '') return null
    return value.trim()
}

// Every reason `pnpm release X.Y.Z --npm` refuses, before it builds or publishes.
export function npmPublishProblems(state) {
    const problems = []
    const version = state.version
    if (state.dirty.length) {
        problems.push(
            `The working tree is not clean (${state.dirty.length} changed or untracked path(s), first: ${state.dirty[0]}). Commit or remove them.`
        )
    }
    if (!state.tagExists) problems.push(`Tag v${version} does not exist.`)
    else if (!state.tagAnnotated) problems.push(`v${version} is not an annotated tag.`)
    else if (state.head !== state.tagCommit)
        problems.push(`HEAD is ${short(state.head)}, not the annotated tag v${version} (${short(state.tagCommit)}).`)
    const mismatched = (state.versions || []).filter((item) => item.version !== version)
    if (mismatched.length) {
        problems.push(
            `Package versions must equal ${version}: ${mismatched
                .map((item) => `${item.file} is ${item.version ?? 'missing'}`)
                .join(', ')}.`
        )
    }
    if (state.imageError) problems.push(`Could not check the image ${npmImageRef(version)} in the registry.`)
    else if (!state.imageExists) problems.push(`The image ${npmImageRef(version)} is not in the registry.`)
    if (state.githubRelease === 'draft') problems.push(`The GitHub release v${version} is still a draft.`)
    else if (state.githubRelease !== 'published') problems.push(`The GitHub release v${version} is not published.`)
    if (!state.npmToken) problems.push('NPM_TOKEN is not set.')
    return problems
}

export function redactSecret(text, secret) {
    if (!secret || !text) return text
    return String(text).split(secret).join('NPM_TOKEN')
}

function short(sha) {
    return sha ? String(sha).slice(0, 7) : 'none'
}

export function localDate(now = new Date()) {
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

export const HELP = `pnpm release [X.Y.Z | major | minor | patch] [options]

Cuts a release from a clean main that matches origin/main. The version defaults to the
"## [X.Y.Z] - Unreleased" heading in CHANGELOG.md.

  --dry-run           change nothing: run every check, print the plan and the release notes
  --local             stop before anything leaves this machine (no git push, no draft release)
  --push              also push the image (multi-arch when buildx can build linux/arm64)
  --publish           publish the GitHub release instead of leaving a draft
  --npm               publish cuttlely and @cuttlely/chat from the annotated tag vX.Y.Z
  --image <name>      image name (default ghcr.io/<owner>/<repo>)
  --skip-image-check  do not start the local image to check /api/v1/ping

Without --push and --publish, the image stays on this machine and the GitHub release is a draft.
--npm is a later step, from that tag, after the image and the GitHub release are public.
See docs/releases.md.`

// ---------- side effects ----------

function run(cmd, args, { cwd, allowFail = false, capture = true, env } = {}) {
    const res = spawnSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 64 * 1024 * 1024
    })
    if (res.error) {
        if (allowFail) return { status: -1, stdout: '', stderr: res.error.message }
        throw new ReleaseError(`${cmd} could not start: ${res.error.message}`)
    }
    if (res.status !== 0 && !allowFail) {
        const detail = capture ? `\n${(res.stderr || res.stdout || '').trim()}` : ''
        throw new ReleaseError(`${cmd} ${args.join(' ')} failed (exit ${res.status}).${detail}`)
    }
    return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() }
}

function git(root, args, opts) {
    return run('git', args, { cwd: root, ...opts })
}

function has(cmd, args = ['--version']) {
    return run(cmd, args, { allowFail: true }).status === 0
}

function readState(root, opts) {
    const log = []
    git(root, ['fetch', '--quiet', 'origin', 'main', '--tags'], { allowFail: true })
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean)
    const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }).stdout
    const head = git(root, ['rev-parse', 'HEAD']).stdout
    const originMain = git(root, ['rev-parse', '--verify', '--quiet', 'origin/main'], { allowFail: true }).stdout
    const remoteUrl = git(root, ['config', '--get', 'remote.origin.url'], { allowFail: true }).stdout
    const slug = slugFromRemote(remoteUrl)
    if (!slug) throw new ReleaseError(`origin (${remoteUrl || 'not set'}) is not a GitHub repository.`)

    const versions = VERSION_FILES.map((f) => ({ file: f, version: readPackageVersion(fs.readFileSync(path.join(root, f), 'utf8')) }))
    const currentVersion = versions[0].version
    const versionMismatch = versions.some((v) => v.version !== currentVersion)
        ? `The product version differs between files: ${versions.map((v) => `${v.file} ${v.version}`).join(', ')}. Make them match first.`
        : null

    const changelogText = fs.readFileSync(path.join(root, CHANGELOG), 'utf8')
    let version = opts.version
    if (!version) {
        version = plannedVersion(changelogText)
        if (!version)
            throw new ReleaseError(
                'Give a version (X.Y.Z, major, minor or patch). CHANGELOG.md has no "## [X.Y.Z] - Unreleased" heading to take it from.'
            )
        log.push(`Version ${version} comes from CHANGELOG.md.`)
    } else if (['major', 'minor', 'patch'].includes(version)) {
        version = bumpVersion(currentVersion, version)
    }
    if (!parseSemver(version)) throw new ReleaseError(`${version} is not a version (X.Y.Z or X.Y.Z-rc.N).`)
    const tag = `v${version}`

    const tags = git(root, ['tag', '--list', 'v*'])
        .stdout.split('\n')
        .filter((t) => parseSemver(t.replace(/^v/, '')))
    const latestTag =
        tags
            .filter((t) => t !== tag)
            .sort((a, b) => compareSemver(a.slice(1), b.slice(1)))
            .pop() || null
    const localTag = tags.includes(tag)
    const remoteTag = git(root, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { allowFail: true }).stdout.length > 0

    // Resume: HEAD is the release commit, tagged here, with the versions already bumped.
    let resume = null
    if (localTag) {
        const tagged = git(root, ['rev-list', '-n', '1', tag]).stdout
        if (tagged === head && currentVersion === version) {
            resume = { parent: git(root, ['rev-parse', 'HEAD^'], { allowFail: true }).stdout, pushed: remoteTag }
            log.push(`Resuming: ${tag} is already on this commit.`)
        }
    }

    let changelogProblem = null
    if (!resume) {
        try {
            releaseSection(changelogText, version)
        } catch (error) {
            changelogProblem = error.message
        }
    }

    const image = opts.image || defaultImage(slug)
    const docker = has('docker', ['version', '--format', '{{.Server.Version}}'])
    const gh = has('gh', ['auth', 'status'])
    const imageInRegistry = docker && opts.publish && !opts.push ? has('docker', ['manifest', 'inspect', `${image}:${version}`]) : false
    const builder = docker
        ? buildxInfo(run('docker', ['buildx', 'inspect', '--bootstrap'], { allowFail: true }).stdout)
        : { driver: null, platforms: [] }

    return {
        log,
        dirty,
        branch,
        head,
        originMain,
        slug,
        currentVersion,
        versionMismatch,
        version,
        tag,
        latestTag,
        localTag,
        remoteTag,
        resume,
        changelogText,
        changelogProblem,
        image,
        docker,
        gh,
        imageInRegistry,
        builder,
        multiArch: canBuildMultiArch(builder),
        local: opts.local,
        push: opts.push,
        publish: opts.publish
    }
}

function say(line = '') {
    process.stdout.write(`${line}\n`)
}

function step(title) {
    say(`\n==> ${title}`)
}

function formatCommand(cmd, args) {
    return [cmd, ...args.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a))].join(' ')
}

async function waitForPing(container) {
    const deadline = Date.now() + PING_TIMEOUT_MS
    while (Date.now() < deadline) {
        const res = run('docker', ['exec', container, 'sh', '-c', 'curl -fsS "http://127.0.0.1:${PORT:-43117}/api/v1/ping"'], {
            allowFail: true
        })
        if (res.status === 0 && /pong/.test(res.stdout)) return true
        const state = run('docker', ['inspect', '-f', '{{.State.Running}}', container], { allowFail: true }).stdout
        if (state !== 'true') return false
        await new Promise((r) => setTimeout(r, 3000))
    }
    return false
}

async function checkImage(tag) {
    const name = `cuttlely-release-check-${process.pid}`
    const volume = `${name}-data`
    run('docker', ['run', '-d', '--name', name, '-v', `${volume}:/var/cuttlely`, '-e', 'CUTTLELY_LOCAL_ADMIN=false', tag])
    try {
        const ok = await waitForPing(name)
        if (!ok) {
            const logs = run('docker', ['logs', '--tail', '40', name], { allowFail: true })
            throw new ReleaseError(
                `The image did not answer /api/v1/ping within ${PING_TIMEOUT_MS / 60000} minutes.\n${logs.stdout}\n${logs.stderr}`
            )
        }
    } finally {
        run('docker', ['rm', '-f', name], { allowFail: true })
        run('docker', ['volume', 'rm', '-f', volume], { allowFail: true })
    }
}

export async function main(argv = process.argv.slice(2), root = gitRoot(), deps = {}) {
    const opts = parseArgs(argv)
    if (opts.help) {
        say(HELP)
        return 0
    }
    if (opts.npm) return publishNpmPackages(opts, root, deps)
    const state = readState(root, opts)
    const date = localDate()
    const created = new Date().toISOString()
    const mode = opts.dryRun
        ? 'dry run'
        : opts.local
        ? 'local'
        : [opts.push && 'push', opts.publish && 'publish'].filter(Boolean).join(' + ') || 'draft'
    say(`Cuttlely release ${state.version} (${mode})`)
    for (const line of state.log) say(line)

    step('Checks')
    const problems = preflightProblems(state)
    const checks = [
        ['working tree clean', state.dirty.length === 0],
        ['on main', state.branch === 'main'],
        ['in sync with origin/main', state.resume ? true : state.head === state.originMain],
        ['product versions match', !state.versionMismatch],
        [`tag v${state.version} is new`, state.resume ? 'resume' : !state.localTag && !state.remoteTag],
        ['CHANGELOG.md has the release', state.resume ? 'resume' : !state.changelogProblem],
        ['docker', state.docker],
        [
            'buildx builder for linux/amd64 and linux/arm64',
            state.multiArch ? true : 'no, the image will be linux/amd64 only (docker buildx create --use for multi-arch)'
        ],
        ['gh signed in', state.gh ? true : opts.local ? 'not needed with --local' : false]
    ]
    for (const [label, ok] of checks)
        say(`  ${ok === true ? 'ok  ' : typeof ok === 'string' ? '--  ' : 'FAIL'} ${label}${typeof ok === 'string' ? `: ${ok}` : ''}`)

    const prevTag = state.latestTag
    const nextChangelog = state.resume
        ? state.changelogText
        : state.changelogProblem
        ? null
        : updateChangelog(state.changelogText, { version: state.version, date, slug: state.slug, previousTag: prevTag })
    const notes = nextChangelog ? releaseNotes(nextChangelog, state.version, { image: state.image, slug: state.slug }) : null
    const plan = dockerPlan({
        image: state.image,
        version: state.version,
        sha: state.resume ? state.head : '<release commit>',
        slug: state.slug,
        created,
        multiArch: state.multiArch,
        push: opts.push
    })

    if (opts.dryRun) {
        step('Plan (nothing below runs in a dry run)')
        const lines = []
        if (!state.resume) {
            lines.push('pnpm verify')
            lines.push(`set "version" to ${state.version} in ${formatList(VERSION_FILES)}`)
            lines.push(`CHANGELOG.md: "## [${state.version}] - ${date}", a fresh "## [Unreleased]", compare links`)
            lines.push(formatCommand('git', ['commit', '-m', `Release v${state.version}`]))
            lines.push(formatCommand('git', ['tag', '-a', `v${state.version}`, '-m', `Cuttlely ${state.version}`]))
        }
        lines.push(formatCommand('docker', plan.local))
        if (!opts.skipImageCheck) lines.push(`start ${plan.tags[0]} with a throwaway volume and wait for /api/v1/ping to answer pong`)
        if (!opts.local) {
            lines.push(formatCommand('git', ['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/v${state.version}`]))
            for (const cmd of plan.push) lines.push(formatCommand('docker', cmd))
            lines.push(
                opts.publish
                    ? formatCommand('gh', [
                          'release',
                          'create',
                          `v${state.version}`,
                          '--verify-tag',
                          '--title',
                          `Cuttlely ${state.version}`,
                          '--notes-file',
                          '<notes>',
                          isPrerelease(state.version) ? '--prerelease' : '--latest'
                      ])
                    : formatCommand('gh', [
                          'release',
                          'create',
                          `v${state.version}`,
                          '--verify-tag',
                          '--title',
                          `Cuttlely ${state.version}`,
                          '--notes-file',
                          '<notes>',
                          '--draft'
                      ])
            )
        }
        for (const line of lines) say(`  ${line}`)
        if (nextChangelog) {
            step(`Release notes for v${state.version}`)
            say(notes)
        }
        if (problems.length) {
            step('A real run would refuse')
            for (const p of problems) say(`  - ${p}`)
            return 1
        }
        say('\nDry run passed. A real run would do the steps above.')
        return 0
    }

    if (problems.length) {
        step('Refused')
        for (const p of problems) say(`  - ${p}`)
        return 1
    }

    let sha = state.head
    if (!state.resume) {
        step('pnpm verify')
        run('pnpm', ['verify'], { cwd: root, capture: false })

        step(`Bump to ${state.version} and update CHANGELOG.md`)
        for (const file of VERSION_FILES) {
            const full = path.join(root, file)
            fs.writeFileSync(full, setPackageVersion(fs.readFileSync(full, 'utf8'), state.version))
            say(`  ${file}: ${state.version}`)
        }
        fs.writeFileSync(path.join(root, CHANGELOG), nextChangelog)
        say(`  CHANGELOG.md: ## [${state.version}] - ${date}`)

        step(`Commit and tag v${state.version}`)
        git(root, ['add', '--', ...VERSION_FILES, CHANGELOG])
        git(root, ['commit', '--no-verify', '-m', `Release v${state.version}`])
        const tagMessage = `Cuttlely ${state.version}\n\n${releaseNotes(nextChangelog, state.version)}`
        const tagFile = path.join(os.tmpdir(), `cuttlely-tag-${process.pid}.txt`)
        fs.writeFileSync(tagFile, tagMessage)
        try {
            git(root, ['tag', '-a', `v${state.version}`, '-F', tagFile])
        } finally {
            fs.rmSync(tagFile, { force: true })
        }
        sha = git(root, ['rev-parse', 'HEAD']).stdout
        say(`  ${short(sha)} Release v${state.version}`)
    }

    const realPlan = dockerPlan({
        image: state.image,
        version: state.version,
        sha,
        slug: state.slug,
        created,
        multiArch: state.multiArch,
        push: opts.push
    })
    step(`Build ${realPlan.tags.join(' and ')}`)
    const existing = run(
        'docker',
        ['image', 'inspect', '-f', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', realPlan.tags[0]],
        { allowFail: true }
    )
    if (existing.status === 0 && existing.stdout === sha) {
        say('  Already built from this commit.')
    } else {
        say(`  ${formatCommand('docker', realPlan.local)}`)
        run('docker', realPlan.local, { cwd: root, capture: false })
    }
    if (!opts.skipImageCheck) {
        step('Start the image and wait for /api/v1/ping')
        await checkImage(realPlan.tags[0])
        say('  pong')
    }

    if (opts.local) {
        say(`\nLocal release v${state.version} is ready. Nothing left this machine.`)
        say(`Next: pnpm release ${state.version}            push the commit and tag, draft the GitHub release`)
        say(`      pnpm release ${state.version} --push --publish   also push the image and publish`)
        say(`      pnpm release ${state.version} --npm   publish the npm packages from the tag, after both are public`)
        return 0
    }

    step('Push the release commit and tag')
    if (state.remoteTag) {
        say('  Already on origin.')
    } else {
        git(root, ['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/v${state.version}`], {
            capture: false,
            env: { CUTTLELY_SKIP_VERIFY: '1', CUTTLELY_SKIP_HANDOFF_CHECK: '1' }
        })
    }

    if (opts.push) {
        step(`Push ${realPlan.tags.join(' and ')}${state.multiArch ? ' (linux/amd64 and linux/arm64)' : ' (linux/amd64)'}`)
        for (const cmd of realPlan.push) {
            say(`  ${formatCommand('docker', cmd)}`)
            run('docker', cmd, { cwd: root, capture: false })
        }
    }

    step(opts.publish ? 'Publish the GitHub release' : 'Draft the GitHub release')
    const finalChangelog = fs.readFileSync(path.join(root, CHANGELOG), 'utf8')
    const notesFile = path.join(os.tmpdir(), `cuttlely-release-${process.pid}.md`)
    fs.writeFileSync(notesFile, releaseNotes(finalChangelog, state.version, { image: state.image, slug: state.slug }))
    try {
        const view = run('gh', ['release', 'view', `v${state.version}`, '--json', 'isDraft', '--jq', '.isDraft'], {
            cwd: root,
            allowFail: true
        })
        if (view.status === 0) {
            if (opts.publish && view.stdout === 'true') {
                run(
                    'gh',
                    [
                        'release',
                        'edit',
                        `v${state.version}`,
                        '--draft=false',
                        ...(isPrerelease(state.version) ? ['--prerelease'] : ['--latest'])
                    ],
                    { cwd: root }
                )
                say('  Published the existing draft.')
            } else {
                say(`  The release already exists (${view.stdout === 'true' ? 'draft' : 'published'}).`)
            }
        } else {
            const args = [
                'release',
                'create',
                `v${state.version}`,
                '--verify-tag',
                '--title',
                `Cuttlely ${state.version}`,
                '--notes-file',
                notesFile
            ]
            if (opts.publish) args.push(isPrerelease(state.version) ? '--prerelease' : '--latest')
            else args.push('--draft')
            run('gh', args, { cwd: root })
            say(opts.publish ? '  Published.' : '  Draft created. Only people with access to the repository can see it.')
        }
    } finally {
        fs.rmSync(notesFile, { force: true })
    }

    say(`\nRelease v${state.version} done (${mode}).`)
    if (!opts.push) say(`The image is only on this machine. Push it with: pnpm release ${state.version} --push`)
    if (!opts.publish) say(`The GitHub release is a draft. Publish it with: pnpm release ${state.version} --push --publish`)
    say(`After the image is in the registry and the GitHub release is published, from the tag: pnpm release ${state.version} --npm`)
    return 0
}

function readPackageVersions(root, files) {
    return files.map((file) => {
        try {
            return { file, version: readPackageVersion(fs.readFileSync(path.join(root, file), 'utf8')) }
        } catch {
            return { file, version: null }
        }
    })
}

function readPackageName(root, file) {
    const name = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).name
    if (typeof name !== 'string' || !name) throw new ReleaseError(`${file} has no package name.`)
    return name
}

function commandFailed(res, cmd, args, token) {
    if (res && res.error) return `${cmd} could not start.`
    const detail = redactSecret(`${res?.stderr || ''}\n${res?.stdout || ''}`, token).trim()
    const shown = args.map((arg) => (token && arg === token ? 'NPM_TOKEN' : arg)).join(' ')
    return `${cmd} ${shown} failed (exit ${res?.status}).${detail ? `\n${detail}` : ''}`
}

async function publishNpmPackages(opts, root, deps) {
    const log = deps.log || say
    const exec = deps.run || run
    const fetchImpl = deps.fetch || globalThis.fetch
    const env = deps.env || process.env
    const version = opts.version
    const tag = `v${version}`
    const token = npmTokenValue(env)
    const stepTitle = (title) => log(`\n==> ${title}`)

    log(`Cuttlely npm publish ${version}${opts.dryRun ? ' (dry run)' : ''}`)
    stepTitle('Checks')

    const dirty = exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, allowFail: true })
    if (dirty.status !== 0) throw new ReleaseError(commandFailed(dirty, 'git', ['status', '--porcelain'], token))
    const headRes = exec('git', ['rev-parse', 'HEAD'], { cwd: root, allowFail: true })
    if (headRes.status !== 0) throw new ReleaseError(commandFailed(headRes, 'git', ['rev-parse', 'HEAD'], token))
    const tagType = exec('git', ['cat-file', '-t', tag], { cwd: root, allowFail: true })
    const tagExists = tagType.status === 0
    const tagAnnotated = tagExists && tagType.stdout === 'tag'
    const peeled = tagExists ? exec('git', ['rev-parse', `${tag}^{}`], { cwd: root, allowFail: true }) : { status: 1, stdout: '' }
    const manifest = await anonymousManifestExists(version, fetchImpl)
    const releaseView = exec('gh', ['release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft'], { cwd: root, allowFail: true })
    const releaseOut = (releaseView.stdout || '').trim()
    let githubRelease = 'missing'
    if (releaseView.status === 0 && releaseOut === 'false') githubRelease = 'published'
    else if (releaseView.status === 0 && releaseOut === 'true') githubRelease = 'draft'

    const versions = readPackageVersions(root, VERSION_FILES)
    const state = {
        version,
        dirty: (dirty.stdout || '').split('\n').filter(Boolean),
        tagExists,
        tagAnnotated,
        head: headRes.stdout,
        tagCommit: peeled.status === 0 ? peeled.stdout : null,
        versions,
        imageExists: manifest.ok,
        imageError: manifest.error,
        githubRelease,
        npmToken: Boolean(token)
    }
    const problems = npmPublishProblems(state)
    const checks = [
        [`HEAD is the annotated tag ${tag}`, tagExists && tagAnnotated && state.head === state.tagCommit],
        ['working tree clean', state.dirty.length === 0],
        [`package versions are ${version}`, versions.every((item) => item.version === version)],
        [`image ${npmImageRef(version)}`, manifest.ok === true],
        [`GitHub release ${tag} is published`, githubRelease === 'published'],
        ['NPM_TOKEN is set', Boolean(token)]
    ]
    for (const [label, ok] of checks)
        log(`  ${ok === true ? 'ok  ' : typeof ok === 'string' ? '--  ' : 'FAIL'} ${label}${typeof ok === 'string' ? `: ${ok}` : ''}`)

    const plan = [
        'pnpm --dir packages/chat-widget build',
        'npm pack --dry-run (packages/cli)',
        'npm pack --dry-run (packages/chat-widget)',
        'npm publish ./packages/cli (skipped when that version is already on npm)',
        'npm publish ./packages/chat-widget (skipped when that version is already on npm)'
    ]
    if (opts.dryRun) {
        stepTitle('Plan (nothing below runs in a dry run)')
        for (const line of plan) log(`  ${line}`)
        log('  auth is a temporary npm userconfig built from NPM_TOKEN, and the token is not printed')
    }
    if (problems.length) {
        stepTitle(opts.dryRun ? 'A real run would refuse' : 'Refused')
        for (const problem of problems) log(`  - ${problem}`)
        return 1
    }
    if (opts.dryRun) {
        log('\nDry run passed. A real run would publish both packages from this tag.')
        return 0
    }

    stepTitle('Build the chat widget')
    const build = exec('pnpm', ['--dir', 'packages/chat-widget', 'build'], { cwd: root, allowFail: true })
    if (build.status !== 0) throw new ReleaseError(commandFailed(build, 'pnpm', ['--dir', 'packages/chat-widget', 'build'], token))
    log('  built packages/chat-widget')

    stepTitle('npm pack --dry-run')
    for (const file of NPM_PACKAGE_FILES) {
        const dir = path.dirname(file)
        const packed = exec('npm', ['pack', '--dry-run'], { cwd: path.join(root, dir), allowFail: true })
        if (packed.status !== 0) throw new ReleaseError(commandFailed(packed, 'npm', ['pack', '--dry-run'], token))
        log(`  ${dir} packs`)
    }

    stepTitle('Publish')
    const userconfig = path.join(os.tmpdir(), `cuttlely-npm-${process.pid}-${randomBytes(8).toString('hex')}.npmrc`)
    fs.writeFileSync(userconfig, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 })
    try {
        for (const file of NPM_PACKAGE_FILES) {
            const dir = `./${path.dirname(file)}`
            // A run that stopped after the first package starts again from the same tag: skip what npm already has.
            const spec = `${readPackageName(root, file)}@${version}`
            const seen = exec('npm', ['view', spec, 'version', '--userconfig', userconfig], { cwd: root, allowFail: true })
            if (seen.status === 0 && (seen.stdout || '').trim() === version) {
                log(`  ${spec} is already on npm, skipped`)
                continue
            }
            const args = ['publish', dir, '--userconfig', userconfig]
            const published = exec('npm', args, { cwd: root, allowFail: true })
            if (published.status !== 0) throw new ReleaseError(commandFailed(published, 'npm', args, token))
            log(`  published ${dir}`)
        }
    } finally {
        fs.rmSync(userconfig, { force: true })
    }
    log(`\nPublished ${version} to npm from ${tag}.`)
    return 0
}

function gitRoot() {
    const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
    if (res.status !== 0) throw new ReleaseError('Run pnpm release inside the Cuttlely repository.')
    return res.stdout.trim()
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            if (error instanceof ReleaseError) {
                process.stderr.write(`\npnpm release: ${error.message}\n`)
                process.exit(1)
            }
            throw error
        }
    )
}

export const SCRIPT_PATH = fileURLToPath(import.meta.url)
