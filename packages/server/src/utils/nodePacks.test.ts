import fs from 'fs'
import os from 'os'
import path from 'path'
import { StatusCodes } from 'http-status-codes'
import { NodesPool } from '../NodesPool'
import { credentialDefinitionDirs } from './replaceInputsWithConfig'
import { missingNodeFailure, nodePackList, resolveNodePacks } from './nodePacks'

const NODE_SOURCE = `class SampleNode {
    constructor() {
        this.label = 'Sample Pack Node'
        this.name = 'samplePackNode'
        this.version = 1
        this.type = 'SamplePackNode'
        this.icon = ''
        this.category = 'Tools'
        this.description = 'A node from an optional pack'
        this.baseClasses = ['SamplePackNode']
        this.inputs = []
    }
}
module.exports = { nodeClass: SampleNode }
`

const CREDENTIAL_SOURCE = `class SampleCredential {
    constructor() {
        this.label = 'Sample Pack'
        this.name = 'samplePackApi'
        this.version = 1
        this.description = 'A credential from an optional pack'
        this.inputs = []
    }
}
module.exports = { credClass: SampleCredential }
`

function writePack(
    root: string,
    nodePack: { nodes: string; credentials?: string } = { nodes: 'dist/nodes', credentials: 'dist/credentials' }
) {
    fs.mkdirSync(path.join(root, nodePack.nodes), { recursive: true })
    fs.writeFileSync(path.join(root, nodePack.nodes, 'Sample.js'), NODE_SOURCE)
    if (nodePack.credentials) {
        fs.mkdirSync(path.join(root, nodePack.credentials), { recursive: true })
        fs.writeFileSync(path.join(root, nodePack.credentials, 'Sample.credential.js'), CREDENTIAL_SOURCE)
    }
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
            name: 'sample-pack',
            cuttlely: { nodePack }
        })
    )
}

describe('optional node packs', () => {
    let root: string

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-node-pack-'))
    })

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    test('a fixture directory loads its node and credential, then the manifest cache', async () => {
        writePack(root)
        const { packs, skipped } = resolveNodePacks(root)
        expect(skipped).toEqual([])
        expect(packs).toHaveLength(1)
        expect(packs[0].name).toBe('sample-pack')
        expect(packs[0].nodesDir).toBe(path.join(root, 'dist', 'nodes'))
        expect(packs[0].manifestPath).toBe(path.join(root, 'dist', 'nodes-manifest.json'))

        const pool = new NodesPool()
        const first = await pool.loadNodePack(packs[0], { optional: true })
        expect(first.required).toBeGreaterThan(0)
        expect(pool.componentNodes.samplePackNode.nodePack).toBe('sample-pack')
        expect(pool.componentNodes.samplePackNode.label).toBe('Sample Pack Node')
        expect(pool.componentCredentials.samplePackApi.name).toBe('samplePackApi')

        const manifest = JSON.parse(fs.readFileSync(packs[0].manifestPath, 'utf8'))
        expect(manifest.version).toBe(1)
        expect(Object.keys(manifest.nodes)).toHaveLength(1)
        expect(Object.keys(manifest.credentials)).toHaveLength(1)

        const again = new NodesPool()
        const second = await again.loadNodePack(packs[0], { optional: true })
        expect(second.required).toBe(0)
        expect(second.cached).toBeGreaterThan(0)
        expect(again.componentNodes.samplePackNode.nodePack).toBe('sample-pack')
        expect(again.componentCredentials.samplePackApi.name).toBe('samplePackApi')
    })

    test('a package name resolves through the caller, and a bad token is skipped', () => {
        writePack(root)
        const listed = resolveNodePacks(` sample-pack , missing-pack `, {
            resolvePackage: (name) => (name === 'sample-pack' ? root : '')
        })
        expect(listed.packs.map((pack) => pack.name)).toEqual(['sample-pack'])
        expect(listed.skipped).toEqual(['missing-pack'])

        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ name: 'sample-pack', cuttlely: { nodePack: { nodes: '../outside' } } })
        )
        expect(resolveNodePacks(root).skipped).toEqual([root])
    })

    test('a pack does not replace a node that is already loaded', async () => {
        writePack(root)
        const { packs } = resolveNodePacks(root)
        const pool = new NodesPool()
        pool.componentNodes.samplePackNode = { name: 'samplePackNode', label: 'Core' } as (typeof pool.componentNodes)['samplePackNode']
        await pool.loadNodePack(packs[0], { optional: true })
        expect(pool.componentNodes.samplePackNode.label).toBe('Core')
        expect(pool.componentNodes.samplePackNode.nodePack).toBeUndefined()
    })
})

describe('shipped node packs', () => {
    const shipped = '@cuttlely/node-pack-vector-stores'

    test('unset, blank, and an extra list keep the shipped packs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-node-pack-list-'))
        const missing = path.join(dir, 'no-marker')
        expect(nodePackList({}, missing)).toBe(shipped)
        expect(nodePackList({ CUTTLELY_NODE_PACKS: '' }, missing)).toBe(shipped)
        expect(nodePackList({ CUTTLELY_NODE_PACKS: 'sample-pack' }, missing)).toBe(`${shipped},sample-pack`)
        expect(nodePackList({ CUTTLELY_NODE_PACKS: shipped }, missing)).toBe(shipped)
        expect(nodePackList({ CUTTLELY_NODE_PACKS: `sample-pack, ${shipped}, sample-pack` }, missing)).toBe(`${shipped},sample-pack`)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('the slim-image marker skips shipped packs and still adds extras', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-node-pack-list-'))
        const marker = path.join(dir, 'no-node-packs')
        fs.writeFileSync(marker, '')
        expect(nodePackList({ CUTTLELY_NODE_PACKS: 'sample-pack' }, marker)).toBe('sample-pack')
        expect(nodePackList({ CUTTLELY_NODE_PACKS: '' }, marker)).toBe('')
        expect(nodePackList({}, marker)).toBe('')
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('credential input names include an extra pack that loads', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-node-pack-creds-'))
        const credentials = path.join(dir, 'dist', 'credentials')
        fs.mkdirSync(credentials, { recursive: true })
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'extra-pack', cuttlely: { nodePack: { nodes: 'dist/nodes', credentials: 'dist/credentials' } } })
        )
        const previous = process.env.CUTTLELY_NODE_PACKS
        process.env.CUTTLELY_NODE_PACKS = dir
        try {
            expect(credentialDefinitionDirs()).toContain(credentials)
        } finally {
            if (previous === undefined) delete process.env.CUTTLELY_NODE_PACKS
            else process.env.CUTTLELY_NODE_PACKS = previous
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('a saved node that is not installed', () => {
    const flow = JSON.stringify({
        nodes: [
            {
                data: {
                    name: 'samplePackNode',
                    label: 'Sample Pack Node',
                    nodePack: 'sample-pack',
                    inputs: { samplePackApi_CREDENTIAL_ID: 'cred-1' }
                }
            }
        ],
        edges: []
    })

    test('names the pack and refuses the run', () => {
        expect(missingNodeFailure(flow, {})).toEqual({
            statusCode: StatusCodes.UNPROCESSABLE_ENTITY,
            message: 'Sample Pack Node is not installed. Install the sample-pack pack.'
        })
        expect(missingNodeFailure(flow, { samplePackNode: {} })).toBeNull()
        expect(missingNodeFailure(JSON.stringify({ nodes: [{ data: { name: 'gone', label: 'Gone' } }] }), {})).toEqual({
            statusCode: 422,
            message: 'Gone is not installed.'
        })
        expect(missingNodeFailure('not json', {})).toBeNull()
        expect(missingNodeFailure(undefined, {})).toBeNull()
    })
})
