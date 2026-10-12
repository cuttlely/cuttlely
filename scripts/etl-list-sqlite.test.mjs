import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { etlListError, ETL_LOAD_MESSAGE, ETL_SQLITE_MESSAGE } from '../packages/ui/src/views/etl/etlError.mjs'
import { nvmCandidates, selectNode } from './pick-cuttlely-node.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('ETL list on this Node', () => {
    it('lists pipelines without the node:sqlite builtin error', async () => {
        const major = Number(String(process.versions.node).split('.')[0])
        assert.ok(major >= 24, `expected Node 24 or newer, got ${process.version}`)
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-etl-list-'))
        const previous = process.env.CUTTLELY_DATA_DIR
        process.env.CUTTLELY_DATA_DIR = dataDir
        try {
            const importEsm = new Function('specifier', 'return import(specifier)')
            const api = await importEsm(pathToFileURL(path.join(ROOT, 'packages', 'etl', 'api.mjs')).href)
            const rows = api.listPipelineSummaries({ workspaceId: 'etl-sqlite-probe' })
            assert.ok(Array.isArray(rows))
            const text = JSON.stringify(rows)
            assert.equal(text.includes('node:sqlite'), false)
            assert.equal(text.includes('No such built-in module'), false)
            const db = await importEsm(pathToFileURL(path.join(ROOT, 'packages', 'etl', 'db.mjs')).href)
            db.closeDb()
        } finally {
            if (previous === undefined) delete process.env.CUTTLELY_DATA_DIR
            else process.env.CUTTLELY_DATA_DIR = previous
            fs.rmSync(dataDir, { recursive: true, force: true })
        }
    })
})

describe('ETL page error text', () => {
    it('hides the builtin module error and a stack', () => {
        const sqlite = etlListError('No such built-in module: node:sqlite')
        assert.equal(sqlite, ETL_SQLITE_MESSAGE)
        assert.equal(sqlite.includes('node:sqlite'), false)
        const stack = etlListError('No such built-in module: node:sqlite\n    at Module._load (node:internal/modules/cjs/loader:1:1)')
        assert.equal(stack, ETL_SQLITE_MESSAGE)
        assert.equal(etlListError('boom\n    at Module._load (node:internal/modules/cjs/loader:1:1)'), ETL_LOAD_MESSAGE)
        assert.equal(
            etlListError('This ETL pipeline was not found in your workspace.'),
            'This ETL pipeline was not found in your workspace.'
        )
    })
})

describe('Cuttlely node picker', () => {
    it('uses the current binary when it can load node:sqlite', () => {
        const chosen = selectNode()
        assert.ok(chosen)
        assert.equal(chosen.execPath, process.execPath)
        assert.deepEqual(chosen.args, [])
    })

    it('skips a binary that cannot load the built-in and keeps one that can', () => {
        const chosen = selectNode({
            current: '/missing/node',
            extra: ['/also/missing', '/works/node'],
            probe: (execPath) => execPath === '/works/node'
        })
        assert.deepEqual(chosen, { execPath: '/works/node', args: [] })
    })

    it('uses the experimental flag before searching other installs', () => {
        const chosen = selectNode({
            current: '/old/node',
            extra: ['/newer/node'],
            probe: (execPath, args) => execPath === '/old/node' && args.includes('--experimental-sqlite')
        })
        assert.deepEqual(chosen, { execPath: '/old/node', args: ['--experimental-sqlite'] })
    })

    it('reads Node 24 installs under nvm without throwing when the directory is absent', () => {
        const list = nvmCandidates(['/tmp/cuttlely-nvm-missing'])
        assert.deepEqual(list, [])
    })

    it('keeps an empty sqlite flag from being passed as the node binary', () => {
        const text = fs.readFileSync(path.join(ROOT, 'scripts', 'start-cuttlely.sh'), 'utf8')
        assert.equal(text.includes('pick_out="$('), false)
        assert.match(text, /sed -n '1p'/)
        assert.match(text, /sed -n '2p'/)
    })
})
