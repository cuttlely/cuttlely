import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { omitNodePacks } from './omit-node-packs.mjs'

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
}

function storePackage(root, folder, name, deps = {}) {
    const real = path.join(root, 'node_modules', '.pnpm', folder, 'node_modules', ...name.split('/'))
    writeJson(path.join(real, 'package.json'), { name, dependencies: deps })
    return real
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omit-node-packs-'))
    writeJson(path.join(root, 'package.json'), { name: 'cuttlely-workspace', dependencies: { 'run-script-os': '1.0.0' } })
    writeJson(path.join(root, 'packages', 'components', 'package.json'), {
        name: '@cuttlely/components',
        dependencies: { lodash: '1.0.0' }
    })
    writeJson(path.join(root, 'packages', 'server', 'package.json'), {
        name: '@cuttlely/server',
        dependencies: {
            '@cuttlely/components': 'workspace:*',
            '@cuttlely/node-pack-vector-stores': 'workspace:*'
        }
    })
    writeJson(path.join(root, 'packages', 'node-pack-vector-stores', 'package.json'), {
        name: '@cuttlely/node-pack-vector-stores',
        dependencies: { chromadb: '1.0.0', lodash: '1.0.0', '@cuttlely/components': 'workspace:*' }
    })
    const lodash = storePackage(root, 'lodash@1.0.0', 'lodash')
    const chroma = storePackage(root, 'chromadb@1.0.0', 'chromadb', { lodash: '1.0.0' })
    const runner = storePackage(root, 'run-script-os@1.0.0', 'run-script-os')
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    fs.symlinkSync(lodash, path.join(root, 'node_modules', 'lodash'), 'dir')
    fs.symlinkSync(chroma, path.join(root, 'node_modules', 'chromadb'), 'dir')
    fs.symlinkSync(runner, path.join(root, 'node_modules', 'run-script-os'), 'dir')
    const scoped = path.join(root, 'node_modules', '@cuttlely')
    fs.mkdirSync(scoped, { recursive: true })
    fs.symlinkSync(path.join(root, 'packages', 'node-pack-vector-stores'), path.join(scoped, 'node-pack-vector-stores'), 'dir')
    fs.writeFileSync(path.join(chroma, 'index.js'), 'pack-only')
    fs.writeFileSync(path.join(lodash, 'index.js'), 'shared')
    return root
}

test('omitNodePacks deletes pack-only packages and keeps shared ones', () => {
    const root = fixture()
    const removed = omitNodePacks(root)
    assert.ok(removed.some((rel) => rel.includes('chromadb@1.0.0')))
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '.pnpm', 'chromadb@1.0.0')), false)
    assert.equal(fs.existsSync(path.join(root, 'node_modules', 'chromadb')), false)
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '@cuttlely', 'node-pack-vector-stores')), false)
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'lodash', 'index.js'), 'utf8'), 'shared')
    assert.equal(fs.existsSync(path.join(root, 'node_modules', 'run-script-os')), true)
    assert.equal(fs.existsSync(path.join(root, 'packages', 'node-pack-vector-stores', 'package.json')), true)
    fs.rmSync(root, { recursive: true, force: true })
})

test('omitNodePacks leaves an install alone when nothing is pack-only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omit-node-packs-empty-'))
    writeJson(path.join(root, 'package.json'), { name: 'cuttlely-workspace', dependencies: {} })
    writeJson(path.join(root, 'packages', 'components', 'package.json'), {
        name: '@cuttlely/components',
        dependencies: { lodash: '1.0.0' }
    })
    const lodash = storePackage(root, 'lodash@1.0.0', 'lodash')
    fs.symlinkSync(lodash, path.join(root, 'node_modules', 'lodash'), 'dir')
    const removed = omitNodePacks(root)
    assert.deepEqual(removed, [])
    assert.equal(fs.existsSync(path.join(root, 'node_modules', 'lodash')), true)
    fs.rmSync(root, { recursive: true, force: true })
})
