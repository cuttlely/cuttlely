#!/usr/bin/env node
// Cut a Cuttlely release from a maintainer machine. GitHub Actions builds and pushes the release image.
//
//   pnpm release [X.Y.Z | major | minor | patch] [--dry-run] [--local] [--local-image] [--push] [--publish] [--npm]
//
// With no version, the version comes from a "## [X.Y.Z] - Unreleased" heading in CHANGELOG.md.
//
//   --dry-run   change nothing: run the checks, print the plan and the release notes
//   (no flag)   phase 1: verify, bump, update CHANGELOG, commit on a release/vX.Y.Z branch, push that
//               branch, open a pull request into main, and exit. A human founder merges that pull request.
//               phase 2: run the same command again after the merge. It finds the merged pull request,
//               checks that its squash commit has the reviewed tree and the release version, puts the
//               annotated tag vX.Y.Z on that commit and pushes only the tag, opens a main->dev sync pull
//               request, waits for the release-image workflow run and its image, and creates a draft
//               GitHub release
//   --local     stop before anything leaves this machine and build and check the image locally
//   --local-image  use the maintainer-machine image build and start-and-ping check as a fallback
//   --push      with --local-image, also push that local build (multi-arch when available)
//   --publish   publish the GitHub release instead of leaving a draft (needs the image in the registry)
//   --npm       publish the npm packages from the annotated tag, after the image and GitHub release exist
//
// Other options: --image <name> (default ghcr.io/<owner>/<repo>), --skip-image-check (skip the
// start-and-ping check of the local image), --help.
//
// A run that stopped part way can be started again with the same version: a tag that already points
// at the merged commit is reused, and steps that are already done are skipped.
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
const REGISTRY_WAIT_TIMEOUT_MS = 75 * 60 * 1000
const REGISTRY_WAIT_POLL_MS = 15 * 1000
export const RELEASE_IMAGE_WORKFLOW = '.github/workflows/release-image.yml'

export class ReleaseError extends Error {}

// The release commit goes to this branch and reaches main through a pull request.
export function releaseBranch(version) {
    return `release/v${version}`
}

// The release pull request for a version: a merged one wins over an open one. `prs` is the JSON from
// `gh pr list --head release/vX.Y.Z --base main --state all`.
export function pickReleasePr(prs) {
    const list = Array.isArray(prs) ? prs : []
    return list.find((pr) => pr.state === 'MERGED' && pr.mergeCommit?.oid) || list.find((pr) => pr.state === 'OPEN') || null
}

// The commit a remote tag points at, from `git ls-remote origin refs/tags/vX.Y.Z*`. An annotated tag is
// listed twice; the peeled `^{}` line is the commit.
export function remoteTagCommit(lsRemote, tag) {
    let plain = null
    for (const line of (lsRemote || '').split('\n')) {
        const [sha, ref] = line.trim().split(/\s+/)
        if (ref === `refs/tags/${tag}^{}`) return sha
        if (ref === `refs/tags/${tag}`) plain = sha
    }
    return plain
}

// Phase 2 refusals: the merged commit must be the reviewed tree, carry the release version, sit on
// origin/main, and any existing tag must already point at it. A published tag is never moved.
export function tagProblems(state) {
    const { release, version, tag } = state
    const problems = []
    if (state.dirty.length)
        problems.push(
            `The working tree is not clean (${state.dirty.length} changed or untracked path(s), first: ${state.dirty[0]}). Commit or remove them.`
        )
    if (!release.onMain) problems.push(`The merged commit ${short(release.mergeSha)} is not on origin/main.`)
    if (!release.sameTree)
        problems.push(
            `The merged commit ${short(release.mergeSha)} does not have the tree of the reviewed pull request head ${short(
                release.prHead
            )}. main moved after the release branch was cut; cut the release again.`
        )
    const wrong = release.versions.filter((v) => v.version !== version)
    if (wrong.length)
        problems.push(
            `The merged commit ${short(release.mergeSha)} is not version ${version}: ${wrong
                .map((v) => `${v.file} ${v.version}`)
                .join(', ')}.`
        )
    if (release.remoteTagSha && release.remoteTagSha !== release.mergeSha)
        problems.push(`Tag ${tag} on origin points at ${short(release.remoteTagSha)}, not the merged commit ${short(release.mergeSha)}.`)
    if (release.localTagSha && release.localTagSha !== release.mergeSha)
        problems.push(`Tag ${tag} here points at ${short(release.localTagSha)}, not the merged commit ${short(release.mergeSha)}.`)
    if (state.localImage && state.head !== release.mergeSha)
        problems.push(`--local-image builds this checkout. Check out the merged commit ${short(release.mergeSha)} first.`)
    if (state.localImage && !state.docker) problems.push('docker was not found. --local-image builds the image on this machine.')
    if (!state.gh)
        problems.push('gh is not installed or not signed in (gh auth status). It tags the merged release and creates the GitHub release.')
    if (!state.push && state.image !== state.workflowImage)
        problems.push(`The release image workflow publishes only to ${state.workflowImage}. Use --push with a custom --image.`)
    return problems
}

// The main->dev sync pull request after a release: skipped, not failed, when one is already open or
// main has no commit that dev lacks.
export const SYNC_PR_BASE = 'dev'
export function syncPrTitle(version) {
    return `Sync main into dev after v${version}`
}
export function syncPrBody(version) {
    return `Brings the v${version} release commit (version bump and CHANGELOG) from main back into dev.\n\nOpened by pnpm release after the v${version} tag. A person reviews and merges it with a merge commit or by fast-forward. Do not squash it: dev needs the commits that are on main.\n`
}
export function syncPrDecision({ devExists, openSyncPrs, missingCommits }) {
    if (!devExists) return { open: false, reason: `origin has no ${SYNC_PR_BASE} branch, so there is nothing to sync.` }
    if (openSyncPrs.length)
        return { open: false, reason: `A main to ${SYNC_PR_BASE} sync pull request is already open: ${openSyncPrs[0].url}` }
    if (missingCommits === 0) return { open: false, reason: `${SYNC_PR_BASE} already has everything on main.` }
    return { open: true, reason: null }
}

// ---------- pure helpers (tested in scripts/release.test.mjs) ----------

export function parseArgs(argv) {
    const opts = {
        version: null,
        dryRun: false,
        local: false,
        localImage: false,
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
        else if (arg === '--local-image') opts.localImage = true
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
    if (opts.local) opts.localImage = true
    if (opts.npm && (opts.local || opts.push || opts.publish))
        throw new ReleaseError('--npm publishes the npm packages from the tagged release. Run it on its own: pnpm release X.Y.Z --npm.')
    if (opts.npm && !opts.version) throw new ReleaseError('--npm needs a version: pnpm release X.Y.Z --npm.')
    if (opts.npm && !parseSemver(opts.version)) throw new ReleaseError(`--npm needs an exact version (X.Y.Z), not ${opts.version}.`)
    if (opts.push && !opts.localImage)
        throw new ReleaseError(
            '--push is the maintainer-machine fallback. Add --local-image, or let the release-image workflow push the image.'
        )
    if (opts.image && !opts.localImage)
        throw new ReleaseError('--image applies to the maintainer-machine fallback. Add --local-image to use it.')
    if (opts.skipImageCheck && !opts.localImage) throw new ReleaseError('--skip-image-check applies only with --local-image or --local.')
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

export function ciImagePlan({ event, ref, inputTag, inputPlatforms, packageVersion, sha, slug, created, image }) {
    const errors = []
    const targetImage = image || defaultImage(slug)
    const refName = String(ref || '').replace(/^refs\/tags\//, '')
    let mode = null
    let version = null
    let tags = []
    let guard = false
    let platforms = 'linux/amd64'

    if (event === 'push' && refName.startsWith('v')) {
        mode = 'release'
        version = refName.slice(1)
        guard = true
        if (!parseSemver(version)) errors.push(`Tag ${refName} is not a release tag in the form vX.Y.Z or vX.Y.Z-pre.N.`)
        if (packageVersion !== version)
            errors.push(`Tag ${refName} does not match the root package.json version ${packageVersion || 'missing'}.`)
        if (!errors.length) tags = imageTags(targetImage, version)
    } else if (event === 'push' && refName.startsWith('ci-dryrun-')) {
        mode = 'dry-run-tag'
        version = refName
        tags = [`${targetImage}:${refName}`]
    } else if (event === 'workflow_dispatch') {
        mode = 'dispatch'
        version = String(inputTag || '')
        platforms = String(inputPlatforms || 'linux/amd64').trim()
        if (platforms === 'linux/arm64,linux/amd64') platforms = 'linux/amd64,linux/arm64'
        if (platforms !== 'linux/amd64' && platforms !== 'linux/amd64,linux/arm64')
            errors.push('Platforms must be linux/amd64 or linux/amd64,linux/arm64.')
        const rcTag = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/.test(version)
        if (!version) errors.push('The dispatch image tag is required.')
        else if (!version.startsWith('ci-') && !rcTag)
            errors.push('A dispatch image tag must start with ci- or be an rc tag in the form X.Y.Z-rc.N.')
        if (rcTag && packageVersion !== version)
            errors.push(`Tag ${version} does not match the root package.json version ${packageVersion || 'missing'}.`)
        if (!errors.length) tags = [`${targetImage}:${version}`]
    } else {
        errors.push(`Unsupported release image event ${event || 'missing'} for ref ${refName || 'missing'}.`)
    }

    const tagNames = tags.map((tag) => tag.slice(targetImage.length + 1))
    for (const tagName of tagNames) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tagName))
            errors.push(`Image tag ${tagName} does not match the Docker tag grammar ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$.`)
    }

    return {
        mode,
        version,
        image: targetImage,
        tags,
        tagNames,
        labels: version ? imageLabels({ version, sha, slug, created }) : {},
        latest: tags.includes(`${targetImage}:latest`),
        guard,
        platforms,
        errors
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
    if (state.head !== state.originMain)
        problems.push(
            `main is not in sync with origin/main (${short(state.head)} here, ${short(state.originMain)} on origin). Pull or push first.`
        )
    if (state.versionMismatch) problems.push(state.versionMismatch)
    if (state.localTag) problems.push(`Tag v${state.version} already exists here.`)
    if (state.remoteTag) problems.push(`Tag v${state.version} already exists on origin.`)
    if (state.latestTag && compareSemver(state.version, state.latestTag.replace(/^v/, '')) <= 0) {
        problems.push(`${state.version} is not newer than the latest tag ${state.latestTag}.`)
    }
    if (compareSemver(state.version, state.currentVersion) < 0)
        problems.push(`${state.version} is older than the current version ${state.currentVersion}.`)
    if (state.changelogProblem) problems.push(state.changelogProblem)
    if (state.localBranch) problems.push(`Branch ${releaseBranch(state.version)} already exists here.`)
    if (state.remoteBranch && !state.local) problems.push(`Branch ${releaseBranch(state.version)} already exists on origin.`)
    if (state.localImage && !state.docker) problems.push('docker was not found. --local-image builds the image on this machine.')
    if (!state.local && !state.gh)
        problems.push('gh is not installed or not signed in (gh auth status). It opens the release pull request.')
    if (!state.push && state.image !== state.workflowImage)
        problems.push(`The release image workflow publishes only to ${state.workflowImage}. Use --push with a custom --image.`)
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

// Anonymous manifest check for a ghcr.io image. No registry sign-in.
export async function anonymousManifestExists(version, fetchImpl = globalThis.fetch, image = NPM_IMAGE) {
    const prefix = 'ghcr.io/'
    const repository = String(image).startsWith(prefix) ? String(image).slice(prefix.length) : ''
    if (!repository || repository.split('/').some((part) => !part)) return { ok: false, error: true }
    const manifestUrl = `https://ghcr.io/v2/${repository}/manifests/${encodeURIComponent(version)}`
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

export async function waitForRegistryImage(
    { image, version, sha, cwd, resumeCommand = `pnpm release ${version}` },
    {
        fetchImpl = globalThis.fetch,
        runner = run,
        timeoutMs = REGISTRY_WAIT_TIMEOUT_MS,
        pollMs = REGISTRY_WAIT_POLL_MS,
        now = () => Date.now(),
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        log = say
    } = {}
) {
    const started = now()
    const deadline = started + timeoutMs
    const tag = `v${version}`
    log(
        `  Waiting for ${RELEASE_IMAGE_WORKFLOW} run for ${tag} to pass and ${image}:${version} to be available (up to ${Math.ceil(
            timeoutMs / 60000
        )} minutes).`
    )
    for (;;) {
        const listed = runner(
            'gh',
            [
                'run',
                'list',
                '--workflow',
                'release-image.yml',
                '--event',
                'push',
                '--commit',
                sha,
                '--json',
                'databaseId,status,conclusion,headBranch,url'
            ],
            { cwd, allowFail: true }
        )
        let workflowRun = null
        if (listed.status === 0) {
            try {
                const runs = JSON.parse(listed.stdout)
                if (Array.isArray(runs)) workflowRun = runs.find((item) => item && item.headBranch === tag) || null
            } catch {
                workflowRun = null
            }
        }
        if (workflowRun?.status === 'completed') {
            if (workflowRun.conclusion !== 'success') {
                throw new ReleaseError(
                    `${RELEASE_IMAGE_WORKFLOW} run ${workflowRun.url || '(URL unavailable)'} completed with conclusion ${
                        workflowRun.conclusion || 'unknown'
                    }. Resume with ${resumeCommand} after the run passes.`
                )
            }
            const manifest = await anonymousManifestExists(version, fetchImpl, image)
            if (manifest.ok) {
                log(`  ${RELEASE_IMAGE_WORKFLOW} run passed and ${image}:${version} is available.`)
                return true
            }
        }
        const current = now()
        if (current >= deadline) break
        const elapsedSeconds = Math.max(0, Math.floor((current - started) / 1000))
        log(`  Still waiting for the workflow run and image (${elapsedSeconds}s elapsed).`)
        await sleep(Math.min(pollMs, Math.max(0, deadline - current)))
    }
    throw new ReleaseError(
        `Timed out waiting for ${RELEASE_IMAGE_WORKFLOW} run for ${tag} to pass and ${image}:${version} to be available. Check that workflow run, then resume with ${resumeCommand}.`
    )
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
"## [X.Y.Z] - Unreleased" heading in CHANGELOG.md. The release commit goes to a release/vX.Y.Z
branch and reaches main through a pull request.

  --dry-run           change nothing: run every check, print the plan and the release notes
  --local             stop before anything leaves this machine; implies --local-image
  --local-image       build and check the image on this machine as a fallback
  --push              with --local-image, also push that build (multi-arch when available)
  --publish           publish the GitHub release instead of leaving a draft
  --npm               publish cuttlely and @cuttlely/chat from the annotated tag vX.Y.Z
  --image <name>      image name (default ghcr.io/<owner>/<repo>)
  --skip-image-check  do not start the local image to check /api/v1/ping

Phase 1 (by default) pushes release/vX.Y.Z, opens a pull request into main, and exits. A human
founder merges that pull request; a bot never does. Phase 2 is the same command after the merge: it
checks that the squash commit has the reviewed tree and the release version, tags it vX.Y.Z (annotated)
and pushes only the tag, opens a main->dev sync pull request (skipped when one is open or dev already
has main), then the tag starts ${RELEASE_IMAGE_WORKFLOW}; the command waits for its image and creates
a draft GitHub release. --publish publishes after that wait. --push and --image require
--local-image. The local image path retains the build, start-and-ping check, and optional local push.
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
    const branchRef = `refs/heads/${releaseBranch(version)}`
    const localBranch = git(root, ['rev-parse', '--verify', '--quiet', branchRef], { allowFail: true }).stdout.length > 0
    const remoteBranch = git(root, ['ls-remote', '--heads', 'origin', branchRef], { allowFail: true }).stdout.length > 0

    const gh = has('gh', ['auth', 'status'])

    // Phase 2: the release pull request for this version. Open: report it. Merged: tag its squash commit.
    let releasePr = null
    let release = null
    if (gh && !opts.local) {
        const listed = run(
            'gh',
            [
                'pr',
                'list',
                '--repo',
                slug,
                '--base',
                'main',
                '--head',
                releaseBranch(version),
                '--state',
                'all',
                '--json',
                'number,state,url,headRefOid,mergeCommit'
            ],
            { cwd: root, allowFail: true }
        )
        let prs = []
        try {
            prs = listed.status === 0 && listed.stdout ? JSON.parse(listed.stdout) : []
        } catch {
            prs = []
        }
        releasePr = pickReleasePr(prs)
    }
    if (releasePr && releasePr.state === 'MERGED') {
        const mergeSha = releasePr.mergeCommit.oid
        const prHead = releasePr.headRefOid
        // The release branch may be deleted after the merge; the pull request head stays fetchable.
        if (git(root, ['cat-file', '-e', `${prHead}^{commit}`], { allowFail: true }).status !== 0)
            git(root, ['fetch', '--quiet', 'origin', `refs/pull/${releasePr.number}/head`], { allowFail: true })
        const onMain = git(root, ['merge-base', '--is-ancestor', mergeSha, 'origin/main'], { allowFail: true }).status === 0
        const sameTree = git(root, ['diff', '--quiet', prHead, mergeSha], { allowFail: true }).status === 0
        const versions = VERSION_FILES.map((file) => {
            const shown = git(root, ['show', `${mergeSha}:${file}`], { allowFail: true })
            let v = null
            try {
                v = shown.status === 0 ? readPackageVersion(shown.stdout) : null
            } catch {
                v = null
            }
            return { file, version: v }
        })
        const remoteTagSha = remoteTagCommit(
            git(root, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { allowFail: true }).stdout,
            tag
        )
        const localTagSha = localTag ? git(root, ['rev-parse', `${tag}^{commit}`], { allowFail: true }).stdout || null : null
        release = { number: releasePr.number, url: releasePr.url, mergeSha, prHead, onMain, sameTree, versions, remoteTagSha, localTagSha }
        log.push(`Phase 2: release pull request #${releasePr.number} merged as ${short(mergeSha)}.`)
    }

    let changelogProblem = null
    if (!release) {
        try {
            releaseSection(changelogText, version)
        } catch (error) {
            changelogProblem = error.message
        }
    }

    const workflowImage = defaultImage(slug)
    const image = opts.image || workflowImage
    const docker = opts.localImage ? has('docker', ['version', '--format', '{{.Server.Version}}']) : null
    const builder =
        opts.localImage && docker
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
        localBranch,
        remoteBranch,
        releasePr,
        release,
        changelogText,
        changelogProblem,
        image,
        workflowImage,
        docker,
        gh,
        builder,
        multiArch: canBuildMultiArch(builder),
        localImage: opts.localImage,
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

export async function checkImage(tag) {
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
        : [opts.localImage && 'local image', opts.push && 'push', opts.publish && 'publish'].filter(Boolean).join(' + ') || 'draft'
    say(`Cuttlely release ${state.version} (${mode})`)
    for (const line of state.log) say(line)

    if (state.releasePr && state.releasePr.state === 'OPEN') {
        say(`\nThe release pull request for v${state.version} is still open: ${state.releasePr.url}`)
        say('A human founder merges it. Then run this command again to tag the merged commit.')
        return 0
    }
    if (state.release) return tagMergedRelease(state, opts, root, deps, { mode, created })

    step('Checks')
    const problems = preflightProblems(state)
    const checks = [
        ['working tree clean', state.dirty.length === 0],
        ['on main', state.branch === 'main'],
        ['in sync with origin/main', state.head === state.originMain],
        ['product versions match', !state.versionMismatch],
        [`tag v${state.version} is new`, !state.localTag && !state.remoteTag],
        ['CHANGELOG.md has the release', !state.changelogProblem],
        ['gh signed in', state.gh ? true : opts.local ? 'not needed with --local' : false]
    ]
    if (state.localImage) {
        checks.splice(checks.length - 1, 0, ['docker', state.docker])
        checks.splice(checks.length - 1, 0, [
            'buildx builder for linux/amd64 and linux/arm64',
            state.multiArch ? true : 'no, a local push will use linux/amd64 only'
        ])
    }
    printChecks(checks)

    const nextChangelog = state.changelogProblem
        ? null
        : updateChangelog(state.changelogText, { version: state.version, date, slug: state.slug, previousTag: state.latestTag })
    const notes = nextChangelog ? releaseNotes(nextChangelog, state.version, { image: state.image, slug: state.slug }) : null
    const branch = releaseBranch(state.version)

    if (opts.dryRun) {
        step('Plan, phase 1 (nothing below runs in a dry run)')
        const lines = [
            'pnpm verify',
            `set "version" to ${state.version} in ${formatList(VERSION_FILES)}`,
            formatCommand('git', ['switch', '-c', branch]),
            `CHANGELOG.md: "## [${state.version}] - ${date}", a fresh "## [Unreleased]", compare links`,
            formatCommand('git', ['commit', '-m', `Release v${state.version}`])
        ]
        if (state.localImage) {
            const plan = dockerPlan({
                image: state.image,
                version: state.version,
                sha: '<release commit>',
                slug: state.slug,
                created,
                multiArch: state.multiArch,
                push: false
            })
            lines.push(formatCommand('docker', plan.local))
            if (!opts.skipImageCheck) lines.push(`start ${plan.tags[0]} with a temporary volume and wait for /api/v1/ping to answer pong`)
        }
        if (!opts.local) {
            lines.push(formatCommand('git', ['push', '-u', 'origin', branch]))
            lines.push(formatCommand('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', `Release v${state.version}`]))
            lines.push(`then a human founder merges the pull request, and pnpm release ${state.version} (phase 2) tags the merged commit`)
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

    step('pnpm verify')
    run('pnpm', ['verify'], { cwd: root, capture: false })

    step(`Create ${branch}`)
    git(root, ['switch', '-c', branch])

    step(`Bump to ${state.version} and update CHANGELOG.md`)
    for (const file of VERSION_FILES) {
        const full = path.join(root, file)
        fs.writeFileSync(full, setPackageVersion(fs.readFileSync(full, 'utf8'), state.version))
        say(`  ${file}: ${state.version}`)
    }
    fs.writeFileSync(path.join(root, CHANGELOG), nextChangelog)
    say(`  CHANGELOG.md: ## [${state.version}] - ${date}`)

    step(`Commit Release v${state.version}`)
    git(root, ['add', '--', ...VERSION_FILES, CHANGELOG])
    git(root, ['commit', '--no-verify', '-m', `Release v${state.version}`])
    const sha = git(root, ['rev-parse', 'HEAD']).stdout
    say(`  ${short(sha)} Release v${state.version}`)

    if (state.localImage) await buildLocalImage(state, opts, root, { sha, created })

    if (opts.local) {
        say(`\nLocal release v${state.version} is ready on ${branch}. Nothing left this machine, and there is no tag.`)
        say(`Next: push ${branch} and open a pull request into main. A human founder merges it.`)
        say(`      Then pnpm release ${state.version}   tag the merged commit, wait for the image, draft the GitHub release`)
        say(`      pnpm release ${state.version} --npm   publish the npm packages from the tag, after both are public`)
        return 0
    }

    step(`Push ${branch} and open a pull request into main`)
    // The full verify already ran on this tree, so the hook's fast verify and handoff check are skipped.
    git(root, ['push', '-u', 'origin', branch], {
        capture: false,
        env: { CUTTLELY_SKIP_VERIFY: '1', CUTTLELY_SKIP_HANDOFF_CHECK: '1' }
    })
    const notesFile = path.join(os.tmpdir(), `cuttlely-release-pr-${process.pid}.md`)
    fs.writeFileSync(notesFile, releaseNotes(nextChangelog, state.version, { slug: state.slug }))
    try {
        run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', `Release v${state.version}`, '--body-file', notesFile], {
            cwd: root
        })
    } finally {
        fs.rmSync(notesFile, { force: true })
    }
    say(`\nPhase 1 done: the release pull request for v${state.version} is open from ${branch} into main.`)
    say('A human founder merges it; a bot never does. Merging into main deploys.')
    say(
        `Then phase 2: pnpm release ${state.version}   tag the merged commit, open the main to dev sync pull request, draft the GitHub release`
    )
    return 0
}

function printChecks(checks) {
    for (const [label, ok] of checks)
        say(`  ${ok === true ? 'ok  ' : typeof ok === 'string' ? '--  ' : 'FAIL'} ${label}${typeof ok === 'string' ? `: ${ok}` : ''}`)
}

async function buildLocalImage(state, opts, root, { sha, created }) {
    const plan = dockerPlan({
        image: state.image,
        version: state.version,
        sha,
        slug: state.slug,
        created,
        multiArch: state.multiArch,
        push: opts.push
    })
    step(`Build ${plan.tags.join(' and ')}`)
    const existing = run(
        'docker',
        ['image', 'inspect', '-f', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', plan.tags[0]],
        { allowFail: true }
    )
    if (existing.status === 0 && existing.stdout === sha) {
        say('  Already built from this commit.')
    } else {
        say(`  ${formatCommand('docker', plan.local)}`)
        run('docker', plan.local, { cwd: root, capture: false })
    }
    if (!opts.skipImageCheck) {
        step('Start the image and wait for /api/v1/ping')
        await checkImage(plan.tags[0])
        say('  pong')
    }
    return plan
}

// After the tag: the main->dev sync pull request. It never fails the release; a skip or an error is logged.
function openSyncPr(state, root) {
    step(`Open the main to ${SYNC_PR_BASE} sync pull request`)
    const fetched = git(root, ['fetch', '--quiet', 'origin', SYNC_PR_BASE], { allowFail: true })
    const devRef = `refs/remotes/origin/${SYNC_PR_BASE}`
    const devExists = fetched.status === 0 && git(root, ['rev-parse', '--verify', '--quiet', devRef], { allowFail: true }).status === 0
    let openSyncPrs = []
    let missingCommits = 0
    if (devExists) {
        const listed = run(
            'gh',
            ['pr', 'list', '--repo', state.slug, '--base', SYNC_PR_BASE, '--head', 'main', '--state', 'open', '--json', 'number,url'],
            { cwd: root, allowFail: true }
        )
        try {
            openSyncPrs = listed.status === 0 && listed.stdout ? JSON.parse(listed.stdout) : []
        } catch {
            openSyncPrs = []
        }
        missingCommits = Number(git(root, ['rev-list', '--count', `${devRef}..origin/main`], { allowFail: true }).stdout || 0)
    }
    const decision = syncPrDecision({ devExists, openSyncPrs, missingCommits })
    if (!decision.open) {
        say(`  Skipped: ${decision.reason}`)
        return
    }
    const bodyFile = path.join(os.tmpdir(), `cuttlely-sync-pr-${process.pid}.md`)
    fs.writeFileSync(bodyFile, syncPrBody(state.version))
    try {
        const created = run(
            'gh',
            [
                'pr',
                'create',
                '--repo',
                state.slug,
                '--base',
                SYNC_PR_BASE,
                '--head',
                'main',
                '--title',
                syncPrTitle(state.version),
                '--body-file',
                bodyFile
            ],
            { cwd: root, allowFail: true }
        )
        if (created.status === 0) say(`  Opened ${created.stdout || 'the sync pull request'}. It is never merged by this command.`)
        else say(`  Not opened (gh exit ${created.status}): ${created.stderr || created.stdout}. Open it by hand.`)
    } finally {
        fs.rmSync(bodyFile, { force: true })
    }
}

// Phase 2: tag the squash commit of the merged release pull request, push only the tag, open the
// sync pull request, wait for the workflow image, and create the GitHub release.
async function tagMergedRelease(state, opts, root, deps, { mode, created }) {
    const { release, tag, version } = state
    const sha = release.mergeSha
    step('Checks, phase 2')
    const problems = tagProblems(state)
    printChecks([
        ['working tree clean', state.dirty.length === 0],
        [`merged commit ${short(sha)} is on origin/main`, release.onMain],
        [`merged tree equals the reviewed head ${short(release.prHead)}`, release.sameTree],
        [`version files at the merged commit are ${version}`, release.versions.every((v) => v.version === version)],
        [
            `tag ${tag}`,
            release.remoteTagSha
                ? release.remoteTagSha === sha
                    ? 'already on the merged commit'
                    : false
                : release.localTagSha && release.localTagSha !== sha
                ? false
                : true
        ],
        ['gh signed in', state.gh]
    ])

    const tagMessage = `Cuttlely ${version}`
    const releaseCmd = [
        'release',
        'create',
        tag,
        '--verify-tag',
        '--title',
        `Cuttlely ${version}`,
        '--notes-file',
        '<notes>',
        ...(opts.publish ? [isPrerelease(version) ? '--prerelease' : '--latest'] : ['--draft'])
    ]
    if (opts.dryRun) {
        step('Plan, phase 2 (nothing below runs in a dry run)')
        const plan = state.localImage
            ? dockerPlan({ image: state.image, version, sha, slug: state.slug, created, multiArch: state.multiArch, push: opts.push })
            : null
        const lines = []
        if (plan) {
            lines.push(formatCommand('docker', plan.local))
            if (!opts.skipImageCheck) lines.push(`start ${plan.tags[0]} with a temporary volume and wait for /api/v1/ping to answer pong`)
        }
        if (!release.remoteTagSha) {
            if (!release.localTagSha) lines.push(formatCommand('git', ['tag', '-a', tag, sha, '-m', tagMessage]))
            lines.push(formatCommand('git', ['push', 'origin', `refs/tags/${tag}`]))
        }
        lines.push(
            `open a pull request from main into ${SYNC_PR_BASE} titled "${syncPrTitle(
                version
            )}", unless one is open or ${SYNC_PR_BASE} already has main`
        )
        if (plan) for (const cmd of plan.push) lines.push(formatCommand('docker', cmd))
        if (!opts.push)
            lines.push(
                `wait for the ${RELEASE_IMAGE_WORKFLOW} run for ${tag} to pass and ${state.workflowImage}:${version} to be available`
            )
        lines.push(formatCommand('gh', releaseCmd))
        for (const line of lines) say(`  ${line}`)
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

    const plan = state.localImage
        ? await buildLocalImage(state, opts, root, { sha, created })
        : { tags: imageTags(state.image, version), push: [] }

    step(`Tag the merged commit ${short(sha)} as ${tag}`)
    if (release.remoteTagSha === sha) {
        say('  Already on origin.')
    } else {
        if (!release.localTagSha) git(root, ['tag', '-a', tag, sha, '-m', tagMessage])
        // Only the tag is pushed; main is never pushed here. The hook's checks are for branch pushes.
        git(root, ['push', 'origin', `refs/tags/${tag}`], {
            capture: false,
            env: { CUTTLELY_SKIP_VERIFY: '1', CUTTLELY_SKIP_HANDOFF_CHECK: '1' }
        })
    }

    openSyncPr(state, root)

    if (opts.push) {
        step(`Push ${plan.tags.join(' and ')}${state.multiArch ? ' (linux/amd64 and linux/arm64)' : ' (linux/amd64)'}`)
        for (const cmd of plan.push) {
            say(`  ${formatCommand('docker', cmd)}`)
            run('docker', cmd, { cwd: root, capture: false })
        }
    } else {
        step(`Wait for ${RELEASE_IMAGE_WORKFLOW} run for ${tag}`)
        await waitForRegistryImage(
            {
                image: state.workflowImage,
                version,
                sha,
                cwd: root,
                resumeCommand: `pnpm release ${version}${opts.localImage ? ' --local-image' : ''}${opts.publish ? ' --publish' : ''}`
            },
            {
                fetchImpl: deps.fetch || globalThis.fetch,
                runner: deps.run || run,
                timeoutMs: deps.registryTimeoutMs,
                pollMs: deps.registryPollMs,
                now: deps.now,
                sleep: deps.sleep,
                log: deps.log || say
            }
        )
    }

    step(opts.publish ? 'Publish the GitHub release' : 'Draft the GitHub release')
    const changelogAtTag = git(root, ['show', `${sha}:${CHANGELOG}`]).stdout
    const notesFile = path.join(os.tmpdir(), `cuttlely-release-${process.pid}.md`)
    fs.writeFileSync(notesFile, releaseNotes(changelogAtTag, version, { image: state.image, slug: state.slug }))
    try {
        const view = run('gh', ['release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft'], { cwd: root, allowFail: true })
        if (view.status === 0) {
            if (opts.publish && view.stdout === 'true') {
                run('gh', ['release', 'edit', tag, '--draft=false', ...(isPrerelease(version) ? ['--prerelease'] : ['--latest'])], {
                    cwd: root
                })
                say('  Published the existing draft.')
            } else {
                say(`  The release already exists (${view.stdout === 'true' ? 'draft' : 'published'}).`)
            }
        } else {
            run(
                'gh',
                releaseCmd.map((a) => (a === '<notes>' ? notesFile : a)),
                { cwd: root }
            )
            say(opts.publish ? '  Published.' : '  Draft created. Only people with access to the repository can see it.')
        }
    } finally {
        fs.rmSync(notesFile, { force: true })
    }

    say(`\nRelease ${tag} done (${mode}).`)
    if (!opts.publish) say(`The GitHub release is a draft. Publish it with: pnpm release ${version} --publish`)
    say(`After the image is in the registry and the GitHub release is published: git checkout ${tag} && pnpm release ${version} --npm`)
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
