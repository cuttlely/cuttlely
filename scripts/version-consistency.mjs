// Release-facing notices and example pins must follow the root product version.
// This deliberately does not scan changelogs, audit records, or arbitrary version mentions.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/g
const IMAGE_PIN = new RegExp(`\\bghcr\\.io/cuttlely/cuttlely:${VERSION.source}`, 'g')
const WIDGET_PIN = new RegExp(`@cuttlely/chat@${VERSION.source}`, 'g')

// Each row is required. `first` selects only the leading release notice, leaving
// older notices intact. Pins select only concrete image/widget versions, not
// :latest, :local, X.Y.Z, or unrelated dependency versions.
export const RELEASE_SPOTS = [
    {
        file: 'website/src/components/Hero.astro',
        label: 'hero badge',
        pattern: /\bNew in\b|\bdata-release-version\s*=/,
        values: /\bNew in\b[^:<\r\n]*|\bdata-release-version\s*=\s*(?:\{[^}\r\n]*\}|"[^"\r\n]*"|'[^'\r\n]*')/g,
        expression: true
    },
    { file: 'FAQ.md', label: 'FAQ title', pattern: /^# Cuttlely FAQ\b/ },
    { file: 'AGENTS.md', label: 'product introduction', pattern: /^Cuttlely\s+\d/ },
    ...['README.md', 'README.ja.md', 'README.ko.md'].map((file) => ({
        file,
        label: 'release headline',
        pattern: /^(?:\*\*|#{1,6}\s+)(?:New in\s+)?\d+\.\d+\.\d+/,
        // Only the lead version counts; the sentence may name a later release.
        values: /^(?:\*\*|#{1,6}\s+)(?:New in\s+)?\d+\.\d+\.\d+\S*/g,
        first: true,
        currentHeading: true
    })),
    ...[
        ['README.md', /^Latest stable\b/],
        ['README.ja.md', /^最新の安定版/],
        ['README.ko.md', /^최신 안정 버전/],
        ['i18n/README-ZH.md', /^最新稳定版/],
        ['i18n/README-TW.md', /^最新穩定版/]
    ].map(([file, pattern]) => ({ file, label: 'current version and install pins', pattern, currentHeading: true })),
    { file: 'docs/how-to/README.md', label: 'New in heading', pattern: /^#{1,6}\s+New in\b/, first: true, currentHeading: true },
    { file: 'docs/how-to/docker.md', label: 'release image pin', pattern: /\bghcr\.io\/cuttlely\/cuttlely:\d/, values: IMAGE_PIN },
    { file: 'docs/how-to/share-and-embed.md', label: 'widget pin', pattern: /@cuttlely\/chat@\d/, values: WIDGET_PIN },
    {
        file: '.env.example',
        label: 'release image pin',
        pattern: /^\s*#?\s*CUTTLELY_IMAGE=ghcr\.io\/cuttlely\/cuttlely:\d/,
        values: IMAGE_PIN
    },
    { file: 'docker-compose.yml', label: 'release image pin', pattern: /\bghcr\.io\/cuttlely\/cuttlely:\d/, values: IMAGE_PIN }
]

// Omit past-release sections through their next sibling/parent heading. This
// also protects pins copied into historical sections of otherwise current guides.
function currentLines(text, currentHeading) {
    let historyDepth = null
    let keptNewIn = false
    return text.split(/\r?\n/).flatMap((text, index) => {
        const heading = /^\s{0,3}(#{1,6})\s+(.+)/.exec(text)
        if (heading) {
            const depth = heading[1].length
            if (historyDepth !== null && depth <= historyDepth) historyDepth = null
            const title = heading[2]
            const newIn = /^New in\b/i.test(title)
            const historical =
                /^(?:What changed in|What's new in|What was new in|New in|Past releases?|Previous releases?|Older releases?|Historical releases?|Release history|Audit history|Release\s+\d|Version\s+\d|\[?\d+\.\d+\.(?:\d+|x)\b)/i.test(
                    title
                )
            if (historical && !(currentHeading && newIn && !keptNewIn)) historyDepth ??= depth
            if (newIn) keptNewIn = true
        }
        return historyDepth === null ? [{ text, line: index + 1 }] : []
    })
}

// These examples ship in npm tarballs or accompany the checked install pins.
const COMPANION_PINS = {
    'packages/cli/README.md': /The `[^ `]+` pin below selects the [^ ]+ maintenance release|--tag [^ ]+/g,
    'packages/chat-widget/README.md': /The [^ ]+ package matches a [^ ]+ server/g,
    'docs/how-to/docker.md': /selects the `[^`]+` maintenance release|--tag [^ `]+|version such as `[^`]+` pins one/g,
    'docs/how-to/share-and-embed.md': /for a [^ ]+ server/g,
    'docker-compose.yml': /pin the [^ ]+ release image/g
}
export const RELEASE_DOC_FILES = [...new Set([...RELEASE_SPOTS.map((spot) => spot.file), ...Object.keys(COMPANION_PINS)])]

// Draft headlines sit above the current one with a visible "Upcoming" label. Promote
// only the requested version; earlier release descriptions and their links retain their dates.
export function releaseDocText(file, source, previous, version) {
    if (previous === version) return source
    const replaceVersion = (value) => value.replace(VERSION, (found) => (found === previous ? version : found))
    const lines = source.split('\n')
    for (const spot of RELEASE_SPOTS.filter((spot) => spot.file === file)) {
        if (spot.label === 'release headline' || spot.label === 'New in heading') continue
        for (const { line, text } of currentLines(source, spot.currentHeading)) {
            if (!spot.pattern.test(text)) continue
            lines[line - 1] = spot.values ? lines[line - 1].replace(spot.values, replaceVersion) : replaceVersion(lines[line - 1])
            if (spot.first) break
        }
    }
    const companion = COMPANION_PINS[file]
    if (companion) {
        for (const { line } of currentLines(source, false)) lines[line - 1] = lines[line - 1].replace(companion, replaceVersion)
    }
    if (path.basename(file).startsWith('README') && file !== 'docs/how-to/README.md') {
        const marker = /^(?:\*\*(?:Upcoming|次回|다음 릴리스|即将发布|即將發布)\*\* · )/
        for (const [i, line] of lines.entries()) {
            const promoted = line.replace(marker, '')
            if (promoted.startsWith(`**${version} `) || promoted.startsWith(`**${version}에서는`)) lines[i] = promoted
        }
    } else if (file === 'docs/how-to/README.md') {
        const i = lines.findIndex((line) => line.trimEnd() === `## Upcoming · New in ${version}`)
        if (i >= 0) lines[i] = lines[i].replace('Upcoming · ', '')
    }
    return lines.join('\n')
}

export function checkVersionConsistency(
    root = ROOT,
    expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    files = new Map()
) {
    if (typeof expected !== 'string' || !expected) throw new Error('package.json:1: missing root version')
    const errors = []
    for (const spot of RELEASE_SPOTS) {
        if (!files.has(spot.file)) {
            try {
                files.set(spot.file, fs.readFileSync(path.join(root, spot.file), 'utf8'))
            } catch (error) {
                if (error.code !== 'ENOENT') throw error
                files.set(spot.file, null)
            }
        }
        const text = files.get(spot.file)
        const report = (line, found) =>
            errors.push(
                `VERSION-CONSISTENCY ${spot.file}:${line} (${spot.label}): found ${found}; expected ${expected} (root package.json)`
            )
        if (text === null) {
            report(1, '<missing file>')
            continue
        }
        const candidates = currentLines(text, spot.currentHeading).filter(({ text }) => spot.pattern.test(text))
        const selected = spot.first ? candidates.slice(0, 1) : candidates
        if (!selected.length) {
            report(1, '<missing spot>')
            continue
        }
        for (const { text, line } of selected) {
            const value = spot.values ? (text.match(spot.values) ?? []).join('\n') : text
            const versions = new Set(value.match(VERSION) ?? [])
            if (!versions.size && !(spot.expression && /\{\s*version\s*\}/.test(value))) report(line, '<missing version>')
            for (const version of versions) if (version !== expected) report(line, version)
        }
    }
    return { expected, spots: RELEASE_SPOTS.length, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const result = checkVersionConsistency(process.argv[2] ? path.resolve(process.argv[2]) : ROOT)
        if (result.errors.length) {
            process.stderr.write(result.errors.join('\n') + '\n')
            process.exitCode = 1
        } else process.stdout.write(`VERSION-CONSISTENCY: ${result.spots} release spots match ${result.expected}.\n`)
    } catch (error) {
        process.stderr.write(`VERSION-CONSISTENCY: ${error.message}\n`)
        process.exitCode = 1
    }
}
