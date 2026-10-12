// Workspace package names, the server CLI bins, and where the server finds the UI build.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'packages/server/package.json'))

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
}

function workspacePackages() {
    return fs
        .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
        .filter((dir) => dir.isDirectory() && fs.existsSync(path.join(ROOT, 'packages', dir.name, 'package.json')))
        .map((dir) => {
            const rel = path.posix.join('packages', dir.name, 'package.json')
            return { rel, pkg: readJson(rel) }
        })
}

describe('server, UI and API docs package names', () => {
    it('uses a cuttlely name on every workspace package', () => {
        const found = workspacePackages()
        const names = found.map((entry) => entry.pkg.name)
        for (const entry of found) {
            assert.ok(entry.pkg.name === 'cuttlely' || entry.pkg.name.startsWith('@cuttlely/'), `${entry.rel} name is ${entry.pkg.name}`)
        }
        assert.deepEqual(
            [
                found.find((entry) => entry.rel === 'packages/server/package.json').pkg.name,
                found.find((entry) => entry.rel === 'packages/ui/package.json').pkg.name,
                found.find((entry) => entry.rel === 'packages/api-documentation/package.json').pkg.name
            ],
            ['@cuttlely/server', '@cuttlely/ui', '@cuttlely/api-docs']
        )
        assert.ok(names.includes('@cuttlely/components'))
        assert.ok(names.includes('@cuttlely/chat'))
        assert.ok(names.includes('cuttlely'))
    })

    it('keeps the existing server bin and adds cuttlely-server', () => {
        const pkg = readJson('packages/server/package.json')
        assert.equal(pkg.oclif.bin, 'flowise')
        assert.deepEqual(pkg.oclif.binAliases, ['cuttlely-server'])
        assert.equal(pkg.oclif.dirname, 'flowise')
        assert.equal(pkg.bin.flowise, './bin/run')
        assert.equal(pkg.bin['cuttlely-server'], './bin/run')
        assert.equal(pkg.dependencies['@cuttlely/ui'], 'workspace:^')
        assert.equal(pkg.private, true)
        assert.equal(readJson('packages/ui/package.json').private, true)
        assert.equal(readJson('packages/api-documentation/package.json').private, true)
    })

    it('finds the UI build by the UI package name', () => {
        const source = fs.readFileSync(path.join(ROOT, 'packages/server/src/index.ts'), 'utf8')
        assert.match(source, /getNodeModulesPackagePath\('@cuttlely\/ui'\)/)
        const fromDist = path.join(ROOT, 'packages/server/dist')
        const candidates = [1, 2, 3, 4, 5].map((depth) =>
            path.join(fromDist, ...Array(depth).fill('..'), 'node_modules', '@cuttlely', 'ui')
        )
        assert.ok(
            candidates.some((candidate) => fs.existsSync(candidate)),
            `UI package not linked for the server (${candidates[0]})`
        )
    })

    it('keeps CLI config, data and cache directories on the existing bin name', async () => {
        const { Config } = require('@oclif/core')
        const config = await Config.load({ root: path.join(ROOT, 'packages/server') })
        assert.equal(config.bin, 'flowise')
        for (const dir of [config.configDir, config.dataDir, config.cacheDir]) {
            assert.equal(path.basename(dir), 'flowise', dir)
        }
    })
})
