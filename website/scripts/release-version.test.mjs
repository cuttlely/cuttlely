import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { changelogLatestVersion, releaseVersion, repoRoot } from './release-version.mjs'

const tmpDirs = new Set()
after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('releaseVersion', () => {
    it('reads the root package.json version', () => {
        const version = releaseVersion()
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'))
        assert.equal(version, pkg.version)
        assert.match(version, /^\d+\.\d+\.\d+$/)
    })

    it('matches the latest dated CHANGELOG heading', () => {
        assert.equal(releaseVersion(), changelogLatestVersion())
    })

    it('throws when package.json has no release version', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'))
        tmpDirs.add(dir)
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: 'main' }))
        assert.throws(() => releaseVersion(dir), /not a release/)
    })
})

describe('hero source', () => {
    it('does not hardcode a release version and reads releaseVersion()', () => {
        const hero = fs.readFileSync(new URL('../src/components/Hero.astro', import.meta.url), 'utf8')
        assert.match(hero, /releaseVersion\s*\(/)
        assert.match(hero, /from '\.\.\/\.\.\/scripts\/release-version\.mjs'/)
        assert.doesNotMatch(hero, /New in \d+\.\d+\.\d+/)
        assert.doesNotMatch(hero, /data-release-version="\d+\.\d+\.\d+"/)
    })
})
