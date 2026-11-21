import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkVersionConsistency } from './version-consistency.mjs'

const SCRIPT = fileURLToPath(new URL('./version-consistency.mjs', import.meta.url))
const EXPECTED = '2.3.4'
const STALE = '2.3.3'
// Independent examples of the release-facing surfaces, rather than generating
// fixture text from the check's selectors (which could hide a missing selector).
const CONTENTS = {
    'package.json': JSON.stringify({ version: EXPECTED }),
    'website/src/components/Hero.astro': '<p><strong>New in 2.3.4:</strong> Current features.</p>\n',
    'FAQ.md': '# Cuttlely FAQ (2.3.4)\n',
    'AGENTS.md': '# Agent instructions for Cuttlely\n\nCuttlely 2.3.4 gives applications agent teams.\n',
    'README.md':
        '# Cuttlely\n\n**2.3.4 adds current features.**\n\nLatest stable is **2.3.4**. Pin image `2.3.4` or install `cuttlely@2.3.4`.\n',
    'README.ja.md': '# Cuttlely\n\n**2.3.4 では、新しい機能を追加しました。**\n\n最新の安定版は **2.3.4** です。`cuttlely@2.3.4`。\n',
    'README.ko.md': '# Cuttlely\n\n**2.3.4에서는 새로운 기능을 추가합니다.**\n\n최신 안정 버전은 **2.3.4**입니다. `cuttlely@2.3.4`.\n',
    'i18n/README-ZH.md': '# Cuttlely\n\n最新稳定版是 **2.3.4**。`cuttlely@2.3.4`。\n',
    'i18n/README-TW.md': '# Cuttlely\n\n最新穩定版是 **2.3.4**。`cuttlely@2.3.4`。\n',
    'docs/how-to/README.md': '# How-to guides\n\n## New in 2.3.4\n\nCurrent features.\n',
    'docs/how-to/docker.md':
        '# Docker\n\nUse `ghcr.io/cuttlely/cuttlely:latest` by default.\n\n- **Pin a release.** Set `CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:X.Y.Z`, for example `ghcr.io/cuttlely/cuttlely:2.3.4`.\n',
    'docs/how-to/share-and-embed.md': '# Embed\n\nPin `npm install @cuttlely/chat@2.3.4` for a 2.3.4 server.\n',
    '.env.example': '# CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:2.3.4\n',
    'docker-compose.yml':
        '# CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:2.3.4    pin the 2.3.4 release image\nservices:\n  cuttlely:\n    image: ${CUTTLELY_IMAGE:-ghcr.io/cuttlely/cuttlely:latest}\n'
}

function fixture(t, changes = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'version-consistency-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    for (const [file, text] of Object.entries({ ...CONTENTS, ...changes })) {
        if (text === null) continue
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), text)
    }
    return root
}

test('all designated release spots match the root package version', (t) => {
    const result = checkVersionConsistency(fixture(t))
    assert.equal(result.expected, EXPECTED)
    assert.equal(result.spots, 16)
    assert.deepEqual(result.errors, [])
})

for (const file of Object.keys(CONTENTS).filter((file) => file !== 'package.json')) {
    test(`a stale release in ${file} names its file, line, found version and expected version`, (t) => {
        const text = CONTENTS[file].replace(EXPECTED, STALE)
        const line = text.slice(0, text.indexOf(STALE)).split('\n').length
        const errors = checkVersionConsistency(fixture(t, { [file]: text })).errors
        assert.ok(errors.length > 0)
        assert.ok(
            errors.every((error) => error.includes(`${file}:${line} (`)),
            errors.join('\n')
        )
        assert.ok(
            errors.every((error) => error.includes(`found ${STALE}; expected ${EXPECTED}`)),
            errors.join('\n')
        )
    })

    test(`a missing designated file ${file} fails`, (t) => {
        const errors = checkVersionConsistency(fixture(t, { [file]: null })).errors
        assert.ok(
            errors.some((error) => error.includes(`${file}:1 `) && error.includes('<missing file>')),
            errors.join('\n')
        )
    })

    test(`missing release spots in ${file} fail`, (t) => {
        const errors = checkVersionConsistency(fixture(t, { [file]: '# Unrelated content\n' })).errors
        assert.ok(
            errors.some((error) => error.includes(`${file}:1 `) && error.includes('<missing spot>')),
            errors.join('\n')
        )
    })
}

test('each README headline and current-version line is required independently', (t) => {
    for (const file of ['README.md', 'README.ja.md', 'README.ko.md']) {
        for (const removed of ['release headline', 'current version and install pins']) {
            const text = CONTENTS[file]
                .split('\n')
                .filter((line) => (removed === 'release headline' ? !line.startsWith('**') : !line.includes('cuttlely@')))
                .join('\n')
            const errors = checkVersionConsistency(fixture(t, { [file]: text })).errors
            assert.equal(errors.length, 1)
            assert.ok(errors[0].includes(`(${removed}): found <missing spot>`), errors[0])
        }
    }
})

test('every version on a designated line is checked, including a second install pin', (t) => {
    const text = CONTENTS['README.md'].replace('cuttlely@2.3.4', 'cuttlely@2.3.3')
    const errors = checkVersionConsistency(fixture(t, { 'README.md': text })).errors
    assert.equal(errors.length, 1)
    assert.match(errors[0], /README\.md:5 .*found 2\.3\.3; expected 2\.3\.4/)
})

test('every concrete image or widget pin is checked', (t) => {
    for (const [file, pin] of [
        ['docs/how-to/docker.md', '`ghcr.io/cuttlely/cuttlely:2.3.3`'],
        ['docs/how-to/share-and-embed.md', '`@cuttlely/chat@2.3.3`'],
        ['docker-compose.yml', '    image: ghcr.io/cuttlely/cuttlely:2.3.3']
    ]) {
        const errors = checkVersionConsistency(fixture(t, { [file]: CONTENTS[file] + pin + '\n' })).errors
        assert.equal(errors.length, 1)
        assert.ok(errors[0].includes(file) && errors[0].includes(`found ${STALE}`), errors[0])
    }
})

test('hero copy and pin examples may mention unrelated dependency versions', (t) => {
    const changes = {
        'website/src/components/Hero.astro': '<strong>New in 2.3.4:</strong> Supports dependency 1.0.0.\n',
        'docs/how-to/docker.md': CONTENTS['docs/how-to/docker.md'].replace('for example', 'with dependency 1.0.0, for example'),
        'docs/how-to/share-and-embed.md':
            CONTENTS['docs/how-to/share-and-embed.md'] + 'Install `@cuttlely/chat@2.3.4` with dependency 1.0.0.\n'
    }
    assert.deepEqual(checkVersionConsistency(fixture(t, changes)).errors, [])
})

test('history, older notices, changelog entries and unrelated versions are exempt', (t) => {
    const history =
        '\n## What changed in 1.7.8?\n\n**1.7.8 added older features.**\nLatest stable was 1.7.8.\nUse `ghcr.io/cuttlely/cuttlely:1.7.8` and `@cuttlely/chat@1.7.8`.\n\n### Details\nOlder pins stay here: `@cuttlely/chat@1.7.7`.\n'
    const changes = Object.fromEntries(
        Object.entries(CONTENTS)
            .filter(([file]) => file.endsWith('.md'))
            .map(([file, text]) => [file, text + history])
    )
    changes['README.md'] = CONTENTS['README.md'] + '\n**1.7.7 fixed earlier features.**\n' + history
    changes['docs/how-to/README.md'] += '\n## New in 1.7.7\n\nOlder features.\n'
    changes['docs/how-to/docker.md'] += '\n## Previous releases\n`ghcr.io/cuttlely/cuttlely:1.7.6`\n'
    changes['CHANGELOG.md'] = '# Changelog\n\n## [1.7.8]\n\nOld release; `@cuttlely/chat@1.7.8`.\n'
    changes['docs/how-to/share-and-embed.md'] += '\n## Dependencies\nUse unrelated-library@1.0.0.\n'
    assert.deepEqual(checkVersionConsistency(fixture(t, changes)).errors, [])
})

test('a current pin after a historical section is still checked', (t) => {
    const file = 'docs/how-to/docker.md'
    const text =
        CONTENTS[file] + '\n## What changed in 1.7.8\n`ghcr.io/cuttlely/cuttlely:1.7.8`\n\n## Install\n`ghcr.io/cuttlely/cuttlely:2.3.3`\n'
    const errors = checkVersionConsistency(fixture(t, { [file]: text })).errors
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes(`found ${STALE}; expected ${EXPECTED}`), errors[0])
})

test('a historical section cannot stand in for a missing current spot', (t) => {
    const file = 'docs/how-to/docker.md'
    const errors = checkVersionConsistency(
        fixture(t, { [file]: '# Docker\n\n## What changed in 1.7.8\n`ghcr.io/cuttlely/cuttlely:2.3.4`\n' })
    ).errors
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes(`${file}:1 `) && errors[0].includes('<missing spot>'), errors[0])
})

test('similar past-release and audit headings exempt their pins', (t) => {
    const file = 'docs/how-to/docker.md'
    for (const heading of ['New in 1.7.8', "What's new in 1.7.8?", '1.7.8 release', '[1.7.8]', 'Version 1.7.8', 'Audit history']) {
        const text = CONTENTS[file] + `\n## ${heading}\n\nUse ghcr.io/cuttlely/cuttlely:1.7.8.\n`
        assert.deepEqual(checkVersionConsistency(fixture(t, { [file]: text })).errors, [], heading)
    }
})

test('the hero accepts a build-time version expression with the release marker', (t) => {
    const hero =
        '---\nimport { version } from "../../../package.json"\n---\n<strong data-release-version={version}>New in {version}:</strong>\n'
    assert.deepEqual(checkVersionConsistency(fixture(t, { 'website/src/components/Hero.astro': hero })).errors, [])
})

test('a boolean release marker on its own line is accepted with the build-time badge', (t) => {
    const hero = '<p data-release-version>\n    <strong>New in {version}:</strong> Current features.\n</p>\n'
    assert.deepEqual(checkVersionConsistency(fixture(t, { 'website/src/components/Hero.astro': hero })).errors, [])
})

test('a README may use a New in heading for its leading release notice', (t) => {
    const text = CONTENTS['README.md'].replace('**2.3.4 adds current features.**', '## New in 2.3.4')
    assert.deepEqual(checkVersionConsistency(fixture(t, { 'README.md': text })).errors, [])
})

test('a README headline may name a later release in its sentence; only the lead version counts', (t) => {
    const ok = CONTENTS['README.md'].replace(
        '**2.3.4 adds current features.**',
        '**2.3.4 adds current features.** The rest is tracked for 2.3.5.'
    )
    assert.deepEqual(checkVersionConsistency(fixture(t, { 'README.md': ok })).errors, [])
    const stale = ok.replace('**2.3.4 adds', '**2.3.3 adds')
    const errors = checkVersionConsistency(fixture(t, { 'README.md': stale })).errors
    assert.equal(errors.length, 1)
    assert.match(errors[0], /README\.md:3 .*found 2\.3\.3; expected 2\.3\.4/)
})

test('the release marker does not hide a stale literal hero badge or attribute', (t) => {
    for (const hero of [
        '<strong data-release-version={version}>New in 2.3.3:</strong>\n',
        '<strong data-release-version="2.3.3">New in {version}:</strong>\n'
    ]) {
        const errors = checkVersionConsistency(fixture(t, { 'website/src/components/Hero.astro': hero })).errors
        assert.equal(errors.length, 1)
        assert.match(errors[0], /Hero\.astro:1 .*found 2\.3\.3; expected 2\.3\.4/)
    }
})

test('a hero notice with no literal version or version expression fails', (t) => {
    const errors = checkVersionConsistency(
        fixture(t, { 'website/src/components/Hero.astro': '<strong>New in this release:</strong>\n' })
    ).errors
    assert.equal(errors.length, 1)
    assert.match(errors[0], /Hero\.astro:1 .*found <missing version>; expected 2\.3\.4/)
})

test('prerelease and build suffixes must match the root version exactly', (t) => {
    const next = '2.3.4-rc.1+prep.2'
    const changes = Object.fromEntries(Object.entries(CONTENTS).map(([file, text]) => [file, text.replaceAll(EXPECTED, next)]))
    assert.deepEqual(checkVersionConsistency(fixture(t, changes)).errors, [])
    changes['FAQ.md'] = '# Cuttlely FAQ (2.3.4)\n'
    const errors = checkVersionConsistency(fixture(t, changes)).errors
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes(`found 2.3.4; expected ${next}`), errors[0])
})

test('selectors follow moved lines rather than fixed line numbers', (t) => {
    const file = 'AGENTS.md'
    const text = '\n\n<!-- introduction -->\n' + CONTENTS[file].replace(EXPECTED, STALE)
    const errors = checkVersionConsistency(fixture(t, { [file]: text })).errors
    assert.equal(errors.length, 1)
    assert.match(errors[0], /AGENTS\.md:6 .*found 2\.3\.3; expected 2\.3\.4/)
})

test('the command exits successfully for a matching tree and nonzero with actionable diagnostics for stale or missing spots', (t) => {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    for (const [changes, status, diagnostic] of [
        [{}, 0, /VERSION-CONSISTENCY: 16 release spots match 2\.3\.4/],
        [{ 'FAQ.md': '# Cuttlely FAQ (2.3.3)\n' }, 1, /FAQ\.md:1 .*found 2\.3\.3; expected 2\.3\.4/],
        [{ 'FAQ.md': '# Missing title\n' }, 1, /FAQ\.md:1 .*found <missing spot>; expected 2\.3\.4/]
    ]) {
        const root = fixture(t, changes)
        const output = path.join(root, 'output.log')
        const fd = fs.openSync(output, 'w')
        let result
        try {
            result = spawnSync(process.execPath, [SCRIPT, root], { stdio: ['ignore', fd, fd], env })
        } finally {
            fs.closeSync(fd)
        }
        assert.ifError(result.error)
        const text = fs.readFileSync(output, 'utf8')
        assert.equal(result.status, status, text)
        assert.match(text, diagnostic)
    }
})
