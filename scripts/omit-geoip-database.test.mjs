import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { omitGeoipDatabase } from './omit-geoip-database.mjs'

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omit-geoip-'))
    const real = path.join(root, 'node_modules', '.pnpm', 'geoip-lite@2.0.3', 'node_modules', 'geoip-lite')
    fs.mkdirSync(path.join(real, 'data'), { recursive: true })
    fs.writeFileSync(path.join(real, 'data', 'geo.dat'), 'database')
    const other = path.join(root, 'node_modules', '.pnpm', 'other@1.0.0', 'node_modules', 'other')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'index.js'), 'keep')
    const serverModules = path.join(root, 'packages', 'server', 'node_modules')
    fs.mkdirSync(serverModules, { recursive: true })
    fs.symlinkSync(real, path.join(serverModules, 'geoip-lite'), 'dir')
    const nested = path.join(root, 'node_modules', '.pnpm', 'other@1.0.0', 'node_modules', 'geoip-lite')
    fs.symlinkSync(real, nested, 'dir')
    return root
}

test('omitGeoipDatabase deletes the package and its links and keeps other packages', () => {
    const root = fixture()
    const removed = omitGeoipDatabase(root)
    assert.ok(removed.some((rel) => rel.includes('geoip-lite@2.0.3')))
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '.pnpm', 'geoip-lite@2.0.3')), false)
    assert.equal(fs.existsSync(path.join(root, 'packages', 'server', 'node_modules', 'geoip-lite')), false)
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '.pnpm', 'other@1.0.0', 'node_modules', 'geoip-lite')), false)
    assert.equal(
        fs.readFileSync(path.join(root, 'node_modules', '.pnpm', 'other@1.0.0', 'node_modules', 'other', 'index.js'), 'utf8'),
        'keep'
    )
    fs.rmSync(root, { recursive: true, force: true })
})

test('omitGeoipDatabase leaves an install alone when the package is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omit-geoip-empty-'))
    fs.mkdirSync(path.join(root, 'node_modules', '.pnpm', 'other@1.0.0'), { recursive: true })
    assert.deepEqual(omitGeoipDatabase(root), [])
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '.pnpm', 'other@1.0.0')), true)
    fs.rmSync(root, { recursive: true, force: true })
})
