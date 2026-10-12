import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { repoRoot } from './paths.mjs'

// The web process keeps this cache. A worker process calls boot once, then again
// only when the database was not open yet.
let cached = null

export function resetHarnessNodePoolCache() {
    cached = null
}

// Same pieces packages/server/src/services/harnesses contextFor hands a run:
// the NodesPool registry, the Flowise database, and the cache. Hermes stays on
// 127.0.0.1; this module does not open a port.
export async function bootHarnessNodePool({ loadServer } = {}) {
    if (process.env.CUTTLELY_HARNESS_OFFLINE_MODEL === 'scripted') {
        return { ready: false, skipped: true, reason: 'offline model' }
    }
    if (!loadServer && cached && (cached.ready || cached.built === false)) return cached
    let result
    try {
        const loaded = loadServer ? await loadServer() : await loadBuiltServer()
        result = loaded ? contextFrom(loaded) : notBuilt()
    } catch (error) {
        result = bootFailure(error)
    }
    if (!loadServer && (result.ready || result.built === false)) cached = result
    return result
}

function notBuilt() {
    return {
        ready: false,
        built: false,
        reason: 'Flowise is not built. Run pnpm build before this worker serves live chat models.'
    }
}

function bootFailure(error) {
    const code = String(error?.code || '')
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return notBuilt()
    const name = String(error?.name || 'Error')
        .replace(/password|secret|token|key/gi, '')
        .slice(0, 80)
    return { ready: false, retry: true, reason: `node pool did not start (${name || 'Error'})` }
}

function contextFrom(loaded) {
    const componentNodes = loaded.componentNodes || {}
    const count = Object.keys(componentNodes).length
    if (!count) {
        return { ready: false, built: false, reason: 'The Flowise node pool loaded no nodes. Run pnpm build and restart the worker.' }
    }
    const baseURL = process.env.CUTTLELY_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`
    return {
        ready: true,
        count,
        contextFor: async (record) => ({
            componentNodes,
            flowOptions: {
                appDataSource: loaded.appDataSource,
                databaseEntities: loaded.databaseEntities,
                componentNodes,
                cachePool: loaded.cachePool,
                chatflowid: record?.chatflowId,
                workspaceId: record?.workspaceId || undefined,
                orgId: await orgIdFor(loaded, record?.workspaceId),
                baseURL
            }
        })
    }
}

async function orgIdFor(loaded, workspaceId) {
    if (!workspaceId || !loaded.workspaceEntity || !loaded.appDataSource?.getRepository) return undefined
    try {
        const row = await loaded.appDataSource.getRepository(loaded.workspaceEntity).findOneBy({ id: workspaceId })
        return row?.organizationId || undefined
    } catch {
        return undefined
    }
}

function serverFile(name) {
    return path.join(repoRoot(), 'packages', 'server', 'dist', name)
}

// The web process loads packages/server/.env before it opens the database (commands/base.ts).
// A worker that skips that file uses ~/.cuttlely and cannot decrypt the server's credentials.
export function loadServerEnv(envFile = path.join(repoRoot(), 'packages', 'server', '.env')) {
    if (!envFile || !fs.existsSync(envFile)) return false
    try {
        const require = createRequire(path.join(repoRoot(), 'packages', 'server', 'package.json'))
        const dotenv = require('dotenv')
        dotenv.config({ path: envFile, override: true })
        return true
    } catch (error) {
        const name = String(error?.code || error?.name || 'Error')
            .replace(/password|secret|token|key/gi, '')
            .slice(0, 80)
        console.info(`[harness] worker could not read the server env file (${name || 'Error'})`)
        return false
    }
}

async function loadBuiltServer() {
    loadServerEnv()
    const nodesFile = serverFile('NodesPool.js')
    const dataFile = serverFile('DataSource.js')
    const cacheFile = serverFile('CachePool.js')
    const utilsFile = serverFile('utils/index.js')
    if (![nodesFile, dataFile, cacheFile, utilsFile].every((file) => fs.existsSync(file))) return null
    const require = createRequire(path.join(repoRoot(), 'packages', 'server', 'package.json'))
    const { NodesPool } = require(nodesFile)
    const { getDataSource } = require(dataFile)
    const { CachePool } = require(cacheFile)
    const utils = require(utilsFile)
    const nodesPool = new NodesPool()
    await nodesPool.initialize()
    if (typeof utils.getEncryptionKey === 'function') await utils.getEncryptionKey()
    const appDataSource = getDataSource()
    if (!appDataSource.isInitialized) {
        await appDataSource.initialize()
        if (appDataSource.options?.type === 'sqlite') {
            // The web server owns migrations. Opening the same file here is enough
            // for credential reads; a second migrate races the server on startup.
            await appDataSource.query('PRAGMA synchronous = NORMAL')
        }
    }
    // MODE=queue is the BullMQ server. This worker must not open that Redis just to cache a chat model.
    let cachePool = {}
    if (process.env.MODE !== 'queue') {
        try {
            cachePool = new CachePool()
        } catch {
            cachePool = {}
        }
    }
    const workspaceEntity = appDataSource.entityMetadatas?.find((item) => item.name === 'Workspace')?.target
    return {
        componentNodes: nodesPool.componentNodes,
        appDataSource,
        databaseEntities: utils.databaseEntities,
        cachePool,
        workspaceEntity
    }
}
