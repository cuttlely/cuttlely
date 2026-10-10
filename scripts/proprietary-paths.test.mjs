import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { commercialTreePresent, isCommercialPath, proprietaryViolations, reportedViolations } from './proprietary-paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('proprietary paths', () => {
    it('rejects the commercial identity tree and the old extension paths', () => {
        assert.equal(isCommercialPath('packages/server/src/enterprise/rbac/PermissionCheck.ts'), true)
        assert.equal(isCommercialPath('packages/server/src/IdentityManager.ts'), true)
        assert.equal(isCommercialPath('packages/server/src/StripeManager.ts'), true)
        assert.equal(isCommercialPath('packages/server/dist/enterprise/emails/invite.hbs'), true)
        assert.equal(isCommercialPath('packages/server/dist/IdentityManager.js'), true)
        assert.equal(isCommercialPath('packages/server/dist/StripeManager.d.ts'), true)
        assert.equal(isCommercialPath('packages/server/dist/IdentityManager.js.map'), true)
        assert.equal(isCommercialPath('packages/server/dist/StripeManager.d.ts.map'), true)
        assert.equal(isCommercialPath('packages/server/src/StripeManager.js'), true)
        assert.equal(isCommercialPath('packages/server/src/services/IdentityManager.js.map'), true)
        assert.equal(isCommercialPath('packages/components/nodes/tools/StripeTool/StripeTool.ts'), false)
        assert.equal(isCommercialPath('packages/server/src/identity/directory.ts'), false)
        assert.deepEqual(proprietaryViolations(['extensions/a.ts', 'apps/cloud/index.js', 'apps/oss-app/index.js']), [
            'extensions/a.ts',
            'apps/cloud/index.js'
        ])
        const flagged = proprietaryViolations(['packages/server/src/IdentityManager.ts'])
        assert.deepEqual(flagged, ['packages/server/src/IdentityManager.ts'])
    })

    it('fails a probe that puts the commercial files back', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-commercial-probe-'))
        const enterprise = path.join(root, 'packages/server/src/enterprise')
        fs.mkdirSync(enterprise, { recursive: true })
        fs.writeFileSync(path.join(enterprise, 'marker.ts'), 'export {}\n')
        fs.mkdirSync(path.join(root, 'packages/server/src'), { recursive: true })
        fs.writeFileSync(path.join(root, 'packages/server/src/IdentityManager.ts'), 'export {}\n')
        fs.writeFileSync(path.join(root, 'packages/server/src/StripeManager.ts'), 'export {}\n')
        const present = commercialTreePresent(root)
        assert.ok(present.includes('packages/server/src/enterprise'))
        assert.ok(present.includes('packages/server/src/IdentityManager.ts'))
        assert.ok(present.includes('packages/server/src/StripeManager.ts'))
        const dist = path.join(root, 'packages/server/dist')
        fs.mkdirSync(path.join(dist, 'services'), { recursive: true })
        fs.writeFileSync(path.join(dist, 'IdentityManager.js'), 'module.exports = {}\n')
        fs.writeFileSync(path.join(dist, 'IdentityManager.d.ts'), 'export {}\n')
        fs.writeFileSync(path.join(dist, 'IdentityManager.js.map'), '{}\n')
        fs.writeFileSync(path.join(dist, 'services', 'StripeManager.d.ts.map'), '{}\n')
        fs.writeFileSync(path.join(root, 'packages/server/src/StripeManager.js'), 'module.exports = {}\n')
        const withArtifacts = commercialTreePresent(root)
        assert.ok(withArtifacts.includes('packages/server/dist/IdentityManager.js'))
        assert.ok(withArtifacts.includes('packages/server/dist/IdentityManager.d.ts'))
        assert.ok(withArtifacts.includes('packages/server/dist/IdentityManager.js.map'))
        assert.ok(withArtifacts.includes('packages/server/dist/services/StripeManager.d.ts.map'))
        assert.ok(withArtifacts.includes('packages/server/src/StripeManager.js'))
        fs.rmSync(path.join(root, 'packages/server/src/enterprise'), { recursive: true, force: true })
        fs.rmSync(path.join(root, 'packages/server/src/IdentityManager.ts'), { force: true })
        fs.rmSync(path.join(root, 'packages/server/src/StripeManager.ts'), { force: true })
        fs.rmSync(path.join(root, 'packages/server/src/StripeManager.js'), { force: true })
        fs.rmSync(dist, { recursive: true, force: true })
        assert.deepEqual(commercialTreePresent(root), [])
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('server build deletes compiled IdentityManager and StripeManager outputs', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/server/package.json'), 'utf8'))
        for (const name of [
            'dist/enterprise',
            'dist/IdentityManager.js',
            'dist/IdentityManager.d.ts',
            'dist/IdentityManager.js.map',
            'dist/IdentityManager.d.ts.map',
            'dist/StripeManager.js',
            'dist/StripeManager.d.ts',
            'dist/StripeManager.js.map',
            'dist/StripeManager.d.ts.map'
        ]) {
            assert.equal(pkg.scripts.build.includes(name), true, name)
        }
        assert.equal(pkg.dependencies.stripe, undefined)
    })

    it('finds no commercial tree in this checkout', () => {
        assert.deepEqual(commercialTreePresent(ROOT), [])
        assert.deepEqual(
            reportedViolations(['packages/server/src/enterprise/rbac/PermissionCheck.ts', 'packages/server/src/IdentityManager.ts'], ROOT),
            []
        )
    })
})
