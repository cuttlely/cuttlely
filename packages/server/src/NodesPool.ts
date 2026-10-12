import { IComponentNodes, IComponentCredentials } from './Interface'
import path from 'path'
import fs from 'fs'
import { Dirent } from 'fs'
import { getNodeModulesPackagePath } from './utils'
import { nodePackList, resolveNodePacks, type NodePackLocation } from './utils/nodePacks'
import { promises } from 'fs'
import { ICommonObject, INode } from '@cuttlely/components'
import logger from './utils/logger'
import { appConfig } from './AppConfig'
import { cloneDeep } from 'lodash'
import { createHash } from 'crypto'

const MANIFEST_VERSION = 1
const LOAD_NODE = Symbol('loadNode')

interface FileEntry {
    mtimeMs: number
    size: number
    // sha1 of the file, so a rebuild that leaves the output unchanged keeps the entry.
    hash?: string
    // The instance cannot be described as JSON; it is required on every boot.
    eager?: boolean
}

interface NodeEntry extends FileEntry {
    // null: the file exports no node class or failed to load.
    node: { descriptor: ICommonObject; lazy: string[] } | null
}

interface CredentialEntry extends FileEntry {
    credential: ICommonObject | null
}

interface Manifest {
    version: number
    nodes: Record<string, NodeEntry>
    credentials: Record<string, CredentialEntry>
}

/**
 * Node classes are described once in a manifest next to the components build and loaded
 * on first use. Requiring every node and its dependencies at boot took minutes on a
 * Windows-mounted checkout. A file whose size or content changed is required again at boot.
 * Set CUTTLELY_EAGER_NODES=true to require every node at boot.
 */
export class NodesPool {
    componentNodes: IComponentNodes = {}
    componentCredentials: IComponentCredentials = {}
    private credentialIconPath: ICommonObject = {}
    private descriptors: Record<string, ICommonObject> = {}

    /**
     * Initialize to get all nodes & credentials
     */
    async initialize() {
        const packagePath = getNodeModulesPackagePath('@cuttlely/components')
        const eager = process.env.CUTTLELY_EAGER_NODES === 'true'
        const started = Date.now()
        const core = await this.loadNodePack(
            {
                name: '',
                root: packagePath,
                nodesDir: path.join(packagePath, 'dist', 'nodes'),
                credentialsDir: path.join(packagePath, 'dist', 'credentials'),
                manifestPath: path.join(packagePath, 'dist', 'nodes-manifest.json')
            },
            { eager }
        )
        const { packs, skipped } = resolveNodePacks(nodePackList(), {
            resolvePackage: (name) => getNodeModulesPackagePath(name) || ''
        })
        for (const token of skipped) logger.warn(`[server]: Skipped node pack ${token}`)
        let required = core.required
        let cached = core.cached
        for (const pack of packs) {
            const stats = await this.loadNodePack(pack, { eager, optional: true })
            required += stats.required
            cached += stats.cached
        }
        logger.info(
            `🔧 [server]: Nodes pool: ${Object.keys(this.componentNodes).length} nodes, ${required} files required, ` +
                `${cached} from manifest in ${Date.now() - started}ms`
        )
    }

    /**
     * Load one directory of node and credential classes. Packs use the same manifest
     * (mtime, size, and content hash) as the nodes that ship with the server.
     * A pack does not replace a node or credential that is already registered.
     */
    async loadNodePack(pack: NodePackLocation, options: { eager?: boolean; optional?: boolean } = {}) {
        const eager = options.eager ?? false
        if (options.optional && !fs.existsSync(pack.nodesDir)) {
            logger.warn(`[server]: Node pack ${pack.name || pack.root} has no nodes directory`)
            return { required: 0, cached: 0, moved: 0 }
        }
        const previous = eager ? null : readManifest(pack.manifestPath)
        const manifest: Manifest = { version: MANIFEST_VERSION, nodes: {}, credentials: {} }
        const nodeStats = await this.initializeNodes(pack.nodesDir, previous, manifest, pack.name)
        const credentialStats =
            pack.credentialsDir && fs.existsSync(pack.credentialsDir)
                ? await this.initializeCredentials(pack.credentialsDir, previous, manifest, pack.name)
                : { required: 0, cached: 0, moved: 0 }
        const required = nodeStats.required + credentialStats.required
        const moved = nodeStats.moved + credentialStats.moved
        const cached = nodeStats.cached + credentialStats.cached
        if (!eager && (required > 0 || moved > 0 || !sameFiles(previous, manifest))) writeManifest(pack.manifestPath, manifest)
        return { required, cached, moved }
    }

    /**
     * The node as the nodes API returns it: JSON fields only, without loading the class.
     */
    getNodeDescriptor(name: string): ICommonObject | undefined {
        const descriptor = this.descriptors[name]
        if (descriptor) return JSON.parse(JSON.stringify(descriptor))
        return this.componentNodes[name] ? cloneDeep(this.componentNodes[name]) : undefined
    }

    /**
     * Requires the given lazy nodes one at a time, yielding between them, so the first
     * prediction after boot does not pay for loading its node classes.
     */
    async warm(names: Iterable<string>) {
        const started = Date.now()
        let loaded = 0
        for (const name of names) {
            const load = (this.componentNodes[name] as { [LOAD_NODE]?: () => INode } | undefined)?.[LOAD_NODE]
            if (!load) continue
            await new Promise((resolve) => setImmediate(resolve))
            try {
                load()
                loaded += 1
            } catch (err) {
                logger.warn(`[server]: Could not load node ${name}: ${err}`)
            }
        }
        logger.info(`🔧 [server]: Loaded ${loaded} nodes used by saved flows in ${Date.now() - started}ms`)
    }

    private async initializeNodes(dir: string, previous: Manifest | null, manifest: Manifest, packName = '') {
        const files = (await this.getFiles(dir)).filter((file) => file.endsWith('.js'))
        const stats = { required: 0, cached: 0, moved: 0 }
        const loaded: Array<{ file: string; instance?: INode; descriptor: ICommonObject; lazy: string[] }> = []
        await Promise.all(
            files.map(async (file) => {
                const stat = await promises.stat(file)
                const kept = await keptEntry(file, previous?.nodes[file], stat)
                if (kept) {
                    manifest.nodes[file] = kept.entry
                    stats.cached += 1
                    if (kept.moved) stats.moved += 1
                    if (kept.entry.node) loaded.push({ file, descriptor: kept.entry.node.descriptor, lazy: kept.entry.node.lazy })
                    return
                }
                stats.required += 1
                const entry: NodeEntry = { mtimeMs: stat.mtimeMs, size: stat.size, hash: await fileHash(file), node: null }
                manifest.nodes[file] = entry
                try {
                    const instance = instantiateNode(file)
                    if (!instance) return
                    // Saved on the class before the manifest is written, so a later boot still knows the pack.
                    if (packName) instance.nodePack = packName
                    const described = describe(instance)
                    if (described) entry.node = described
                    else entry.eager = true
                    loaded.push({
                        file,
                        instance,
                        descriptor: described?.descriptor ?? (instance as ICommonObject),
                        lazy: described?.lazy ?? []
                    })
                } catch (err) {
                    logger.error(`❌ [server]: Error during initDatabase with file ${file}:`, err)
                }
            })
        )

        const disabledNodes = process.env.DISABLED_NODES ? process.env.DISABLED_NODES.split(',') : []
        const skipCategories = ['Analytic', 'SpeechToText']
        for (const { file, instance, descriptor, lazy } of loaded) {
            if (packName) descriptor.nodePack = packName
            if (packName && this.componentNodes[descriptor.name]) {
                // The nodes that ship with the server win. A pack that repeats a name is ignored.
                logger.warn(`[server]: Node pack ${packName} also defines ${descriptor.name}; the existing node stays`)
                continue
            }
            if (/\.(svg|png|jpg)$/.test(descriptor.icon ?? '') && descriptor.credential) {
                for (const credName of descriptor.credential.credentialNames ?? []) {
                    this.credentialIconPath[credName] = descriptor.icon
                }
            }
            if (skipCategories.includes(descriptor.category)) continue
            // A pack is an operator choice, so the community-node gate stays on the shipped nodes only.
            if (!packName && !appConfig.showCommunityNodes && descriptor.author) continue
            if (disabledNodes.includes(descriptor.name)) continue
            this.componentNodes[descriptor.name] = instance ?? lazyNode(file, descriptor, lazy)
            if (instance !== descriptor) this.descriptors[descriptor.name] = descriptor
        }
        return stats
    }

    private async initializeCredentials(dir: string, previous: Manifest | null, manifest: Manifest, packName = '') {
        const files = (await this.getFiles(dir)).filter((file) => file.endsWith('.credential.js'))
        const stats = { required: 0, cached: 0, moved: 0 }
        await Promise.all(
            files.map(async (file) => {
                const stat = await promises.stat(file)
                const kept = await keptEntry(file, previous?.credentials[file], stat)
                let credential: ICommonObject | null
                if (kept) {
                    manifest.credentials[file] = kept.entry
                    stats.cached += 1
                    if (kept.moved) stats.moved += 1
                    credential = kept.entry.credential ? { ...kept.entry.credential } : null
                } else {
                    stats.required += 1
                    const credentialModule = require(file)
                    credential = credentialModule.credClass ? new credentialModule.credClass() : null
                    const plain = credential && isPlainInstance(credential) ? toJson(credential) : null
                    manifest.credentials[file] = {
                        mtimeMs: stat.mtimeMs,
                        size: stat.size,
                        hash: await fileHash(file),
                        credential: plain,
                        ...(credential && !plain ? { eager: true } : {})
                    }
                }
                if (!credential) return
                if (packName && this.componentCredentials[credential.name]) {
                    logger.warn(`[server]: Node pack ${packName} also defines credential ${credential.name}; the existing credential stays`)
                    return
                }
                credential.icon = this.credentialIconPath[credential.name] ?? ''
                this.componentCredentials[credential.name] = credential as INode
            })
        )
        return stats
    }

    /**
     * Recursive function to get node files
     * @param {string} dir
     * @returns {string[]}
     */
    private async getFiles(dir: string): Promise<string[]> {
        const dirents = await promises.readdir(dir, { withFileTypes: true })
        const files = await Promise.all(
            dirents.map((dirent: Dirent) => {
                const res = path.resolve(dir, dirent.name)
                return dirent.isDirectory() ? this.getFiles(res) : res
            })
        )
        return Array.prototype.concat(...files)
    }
}

async function keptEntry<T extends FileEntry>(file: string, known: T | undefined, stat: fs.Stats) {
    if (!known || known.eager || known.size !== stat.size) return null
    if (known.mtimeMs === stat.mtimeMs) return { entry: known, moved: false }
    if (!known.hash || known.hash !== (await fileHash(file))) return null
    return { entry: { ...known, mtimeMs: stat.mtimeMs }, moved: true }
}

async function fileHash(file: string): Promise<string> {
    return createHash('sha1')
        .update(await promises.readFile(file))
        .digest('hex')
}

function instantiateNode(file: string): INode | null {
    const nodeModule = require(file)
    if (!nodeModule.nodeClass) return null
    const instance = new nodeModule.nodeClass()
    instance.filePath = file
    if (instance.icon && /\.(svg|png|jpg)$/.test(instance.icon)) {
        instance.icon = path.join(path.dirname(file), instance.icon).replace(/\\/g, '/')
    }
    return instance
}

function lazyNode(file: string, descriptor: ICommonObject, lazyKeys: string[]): INode {
    const lazy = new Set(lazyKeys)
    const data: ICommonObject = {}
    for (const [key, value] of Object.entries(descriptor)) if (!lazy.has(key)) data[key] = value
    let real: any
    const load = () => {
        if (!real) {
            real = instantiateNode(file)
            if (!real) throw new Error(`Node file ${file} no longer exports nodeClass`)
            Object.assign(real, data)
        }
        return real
    }
    return new Proxy(data, {
        get(target, prop, receiver) {
            if (prop === LOAD_NODE) return load
            if (typeof prop === 'string' && lazy.has(prop)) return load()[prop]
            return Reflect.get(target, prop, receiver)
        },
        set(target, prop, value) {
            if (real || (typeof prop === 'string' && lazy.has(prop))) load()[prop] = value
            target[prop as string] = value
            return true
        },
        has(target, prop) {
            return (typeof prop === 'string' && lazy.has(prop)) || Reflect.has(target, prop)
        }
    }) as INode
}

/**
 * Splits a node into the JSON the API serves and the keys that need the real class:
 * methods anywhere on the prototype chain and own fields that do not survive JSON.
 */
function describe(instance: INode): { descriptor: ICommonObject; lazy: string[] } | null {
    const descriptor = toJson(instance)
    if (!descriptor) return null
    const lazy = new Set<string>()
    for (const [key, value] of Object.entries(instance)) {
        if (value !== undefined && !isPlainJson(value)) lazy.add(key)
    }
    let proto = Object.getPrototypeOf(instance)
    while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) if (key !== 'constructor') lazy.add(key)
        proto = Object.getPrototypeOf(proto)
    }
    return { descriptor, lazy: [...lazy] }
}

function isPlainInstance(instance: object): boolean {
    const proto = Object.getPrototypeOf(instance)
    if (proto && Object.getOwnPropertyNames(proto).some((key) => key !== 'constructor')) return false
    return Object.values(instance).every((value) => value === undefined || isPlainJson(value))
}

function isPlainJson(value: unknown): boolean {
    if (value === null) return true
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return true
        case 'number':
            return Number.isFinite(value)
        case 'object': {
            if (Array.isArray(value)) return value.every((item) => item !== undefined && isPlainJson(item))
            const proto = Object.getPrototypeOf(value)
            if (proto !== Object.prototype && proto !== null) return false
            return Object.values(value as object).every((item) => item === undefined || isPlainJson(item))
        }
        default:
            return false
    }
}

function toJson(value: unknown): ICommonObject | null {
    try {
        return JSON.parse(JSON.stringify(value))
    } catch {
        return null
    }
}

function readManifest(file: string): Manifest | null {
    try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
        return manifest?.version === MANIFEST_VERSION ? manifest : null
    } catch {
        return null
    }
}

function writeManifest(file: string, manifest: Manifest) {
    try {
        const temp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(temp, JSON.stringify(manifest))
        fs.renameSync(temp, file)
    } catch (err) {
        logger.warn(`[server]: Could not write the nodes manifest ${file}: ${err}`)
    }
}

function sameFiles(previous: Manifest | null, next: Manifest): boolean {
    if (!previous) return false
    const a = Object.keys(previous.nodes).length + Object.keys(previous.credentials).length
    const b = Object.keys(next.nodes).length + Object.keys(next.credentials).length
    return a === b
}
