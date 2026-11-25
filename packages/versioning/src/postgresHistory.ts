import { AsyncLocalStorage } from 'async_hooks'
import { initGithubRecovery, restoreGithubRecovery, saveGithubRecovery } from './githubRecovery'
// Keep the initial main history and subsequent fast-forward bundles in PostgreSQL.
// Git still provides the existing SHA, diff, restore and credential-redaction semantics.
import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { runGit, VersionStore } from './store'

type Tx = { query(sql: string, params?: unknown[]): Promise<any[]> }
export type HistorySource = { transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> }
const bundles = 'cuttlely_versions.bundles'
const chunks = 'cuttlely_versions.chunks'
const block = 1024 * 1024

async function git(dir: string, args: string[]) {
    return (await runGit(dir, ['-c', 'core.hooksPath=' + os.devNull, ...args])).stdout.trim()
}

async function exists(file: string) {
    try {
        await fs.lstat(file)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

export async function localVersionHead(dir: string): Promise<string | null> {
    if (!(await exists(path.join(dir, '.git')))) {
        if ((await exists(dir)) && (await fs.readdir(dir)).length)
            throw new Error('The versions directory contains files but no repository.')
        return null
    }
    if ((await git(dir, ['symbolic-ref', 'HEAD'])) !== 'refs/heads/main')
        throw new Error('Select the main branch in the versions repository.')
    const head = await git(dir, ['for-each-ref', '--format=%(objectname)', 'refs/heads/main'])
    return head || null
}

export async function versionInventory(dir: string) {
    const head = await localVersionHead(dir)
    if (!head) return null
    const bytes = Number(await git(dir, ['rev-list', '--disk-usage', '--objects', '--all']))
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Could not estimate the size of the flow history.')
    return { head, bytes }
}

async function init(dir: string) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await git(dir, ['init', '-q', '-b', 'main'])
}

async function scratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlely-versions-'))
    try {
        return await work(dir)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
}

async function readBundle(tx: Tx, dir: string, row: { id: string; head: string; digest: string; parts: number }) {
    await scratch(async (tmp) => {
        const file = path.join(tmp, 'history.bundle')
        const fd = await fs.open(file, 'wx', 0o600)
        const hash = createHash('sha256')
        try {
            for (let seq = 0; seq < row.parts; seq++) {
                const [part] = await tx.query('SELECT content FROM ' + chunks + ' WHERE bundle=$1 AND seq=$2', [row.id, seq])
                if (!part) throw new Error('A PostgreSQL revision bundle is incomplete.')
                hash.update(part.content)
                await fd.writeFile(part.content)
            }
        } finally {
            await fd.close()
        }
        if (hash.digest('hex') !== row.digest) throw new Error('PostgreSQL revision bundle checksum mismatch.')
        await git(dir, ['bundle', 'verify', file])
        const refs = await git(dir, ['bundle', 'unbundle', file])
        if (refs !== row.head + ' refs/heads/main') throw new Error('Unexpected revision in PostgreSQL bundle.')
    })
}

async function saveBundle(tx: Tx, dir: string, head: string, base: string | null) {
    await scratch(async (tmp) => {
        const file = path.join(tmp, 'history.bundle')
        await git(dir, ['bundle', 'create', file, 'refs/heads/main', ...(base ? ['^' + base] : [])])
        const [row] = await tx.query('INSERT INTO ' + bundles + '(head,base) VALUES ($1,$2) RETURNING id', [head, base])
        const hash = createHash('sha256')
        let parts = 0
        for await (const data of createReadStream(file, { highWaterMark: block })) {
            hash.update(data)
            await tx.query('INSERT INTO ' + chunks + ' VALUES ($1,$2,$3)', [row.id, parts++, data])
        }
        const digest = hash.digest('hex')
        await tx.query('UPDATE ' + bundles + ' SET parts=$2,digest=$3 WHERE id=$1', [row.id, parts, digest])
        // For an import, verify the persisted pack with no objects from the original filesystem.
        if (!base) {
            const verify = path.join(tmp, 'verify')
            await init(verify)
            await readBundle(tx, verify, { id: row.id, parts, digest, head })
            await git(verify, ['fsck', '--no-reflogs', '--full', head])
        }
    })
}

export class PostgresHistory {
    constructor(private source: HistorySource, private repo: VersionStore) {}

    private locked<T>(work: (tx: Tx) => Promise<T>) {
        return this.source.transaction(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('cuttlely-version-history',516))")
            return work(tx)
        })
    }

    async open(expected?: string | null, enabled = true) {
        await this.locked(async (tx) => {
            await tx.query('CREATE SCHEMA IF NOT EXISTS cuttlely_versions')
            await tx.query(
                'CREATE TABLE IF NOT EXISTS ' +
                    bundles +
                    '(id bigserial PRIMARY KEY, head text UNIQUE NOT NULL, base text, parts int, digest text)'
            )
            await tx.query(
                'CREATE TABLE IF NOT EXISTS ' +
                    chunks +
                    '(bundle bigint REFERENCES ' +
                    bundles +
                    '(id), seq integer, content bytea NOT NULL, PRIMARY KEY(bundle,seq))'
            )
            const [registry] = await tx.query("SELECT to_regclass('cuttlely_storage.owned_schema') AS registry")
            if (registry.registry)
                await tx.query(
                    "INSERT INTO cuttlely_storage.owned_schema(name,oid) SELECT nspname,oid FROM pg_namespace WHERE nspname='cuttlely_versions' ON CONFLICT DO NOTHING"
                )
            const local = await localVersionHead(this.repo.dir)
            if (expected !== undefined && local !== expected)
                throw new Error('The source version history changed. Use the original verified versions directory.')
            if (expected !== undefined) {
                const [target] = await tx.query('SELECT head FROM ' + bundles + ' ORDER BY id DESC LIMIT 1')
                if (target && target.head !== expected)
                    throw new Error('The destination version history differs from the migration source.')
                if (local && (await git(this.repo.dir, ['status', '--porcelain', '--untracked-files=normal'])))
                    throw new Error('Resolve uncommitted files in the versions repository before migrating.')
            }
            if (!local && enabled && !(await tx.query('SELECT 1 FROM ' + bundles + ' LIMIT 1')).length) {
                await this.repo.ensure()
            }
            await this.sync(tx, local || (await localVersionHead(this.repo.dir)))
            await initGithubRecovery(tx)
            await restoreGithubRecovery(tx, this.repo.dir, expected !== undefined)
        })
    }

    private async sync(tx: Tx, local: string | null): Promise<string | null> {
        const [latest] = await tx.query('SELECT head FROM ' + bundles + ' ORDER BY id DESC LIMIT 1')
        if (!latest) {
            if (local) await saveBundle(tx, this.repo.dir, local, null)
            return local
        }
        if (latest.head === local) return local
        let after = '0'
        if (local) {
            const [known] = await tx.query('SELECT id FROM ' + bundles + ' WHERE head=$1', [local])
            if (!known) throw new Error('The local and PostgreSQL version histories differ. Preserve both copies before recovery.')
            after = known.id
        } else {
            await init(this.repo.dir)
        }
        const rows = await tx.query('SELECT id,head,base,parts,digest FROM ' + bundles + ' WHERE id>$1 ORDER BY id', [after])
        let parent = local
        for (const row of rows) {
            if (row.base !== parent) throw new Error('The PostgreSQL version history chain is incomplete.')
            await readBundle(tx, this.repo.dir, row)
            parent = row.head
        }
        await git(this.repo.dir, ['merge', '--ff-only', '--no-edit', latest.head])
        return latest.head
    }

    private readonly githubLease = new AsyncLocalStorage<{ active: boolean }>()

    async withGithubState<T>(work: () => Promise<T>): Promise<T> {
        if (this.githubLease.getStore()?.active) return work()
        return this.locked(async (tx) => {
            await this.sync(tx, await localVersionHead(this.repo.dir))
            await this.repo.ensure()
            await restoreGithubRecovery(tx, this.repo.dir)
            const lease = { active: true }
            try {
                const result = await this.githubLease.run(lease, work)
                await saveGithubRecovery(tx, this.repo.dir)
                return result
            } finally {
                lease.active = false
            }
        })
    }

    refresh() {
        return this.locked(async (tx) => this.sync(tx, await localVersionHead(this.repo.dir)))
    }

    async write(work: (repo: VersionStore) => Promise<string | null>) {
        // Stage the new commit in a private checkout. A failed database transaction never advances the live checkout.
        const result = await this.locked(async (tx) => {
            const base = await this.sync(tx, await localVersionHead(this.repo.dir))
            return scratch(async (tmp) => {
                const stage = new VersionStore(tmp)
                if (base) {
                    await init(tmp)
                    const objects = path.join(this.repo.dir, '.git', 'objects')
                    if (/[\r\n]/.test(objects)) throw new Error('Unsupported newline in the versions directory path.')
                    await fs.writeFile(path.join(tmp, '.git', 'objects', 'info', 'alternates'), objects + '\n')
                    await git(tmp, ['reset', '--hard', base])
                }
                await stage.ensure()
                const sha = await work(stage)
                if (sha) await saveBundle(tx, tmp, sha, base)
                return sha
            })
        })
        if (result) await this.refresh()
        return result
    }
}
