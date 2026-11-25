// The authoring history has its own incremental bundles. GitHub sync also owns named refs and two private files.
import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { runGit } from './store'

type Tx = { query(sql: string, params?: unknown[]): Promise<any[]> }
type Snapshot = { refs: string[]; config: (string | null)[] }
const settings = ['versions-github.json', 'versions-environment.json']
const state = 'cuttlely_versions.github_state'
const chunks = 'cuttlely_versions.github_chunks'
const git = async (dir: string, args: string[]) => (await runGit(dir, ['-c', 'core.hooksPath=' + os.devNull, ...args])).stdout.trim()

async function inventory(dir: string): Promise<Snapshot> {
    if (
        !(await fs.lstat(path.join(dir, '.git')).catch((error) => {
            if (error.code === 'ENOENT') return null
            throw error
        }))
    )
        return { refs: [], config: settings.map(() => null) }
    const refs = (await git(dir, ['for-each-ref', '--sort=refname', '--format=%(objectname) %(refname)']))
        .split('\n')
        .filter((ref) => ref && !ref.endsWith(' refs/heads/main') && !ref.includes(' refs/versions/peek-'))
    const config = await Promise.all(
        settings.map(async (name) => {
            const file = path.join(dir, '.git', name)
            try {
                const stat = await fs.lstat(file)
                if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Unexpected GitHub connection or environment file.')
                return await fs.readFile(file, 'utf8')
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
                throw error
            }
        })
    )
    return { refs, config }
}

export async function initGithubRecovery(tx: Tx) {
    await tx.query(
        'CREATE TABLE IF NOT EXISTS ' +
            state +
            ' (id int PRIMARY KEY CHECK (id=1), snapshot jsonb NOT NULL, digest text NOT NULL, parts integer NOT NULL)'
    )
    await tx.query('CREATE TABLE IF NOT EXISTS ' + chunks + ' (seq integer PRIMARY KEY, content bytea NOT NULL)')
}

async function scratch(work: (file: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cuttlely-git-state-'))
    try {
        await work(path.join(dir, 'refs.bundle'))
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export async function saveGithubRecovery(tx: Tx, dir: string) {
    const snapshot = await inventory(dir)
    const [prior] = await tx.query('SELECT snapshot FROM ' + state + ' WHERE id=1')
    if (prior && same(prior.snapshot.refs, snapshot.refs) && same(prior.snapshot.config, snapshot.config)) return
    if (prior && same(prior.snapshot.refs, snapshot.refs)) {
        await tx.query('UPDATE ' + state + ' SET snapshot=$1 WHERE id=1', [JSON.stringify(snapshot)])
        return
    }
    await tx.query('DELETE FROM ' + chunks)
    const hash = createHash('sha256')
    let parts = 0
    if (snapshot.refs.length)
        await scratch(async (file) => {
            await git(dir, ['bundle', 'create', file, ...snapshot.refs.map((ref) => ref.split(' ')[1])])
            const heads = (await git(dir, ['bundle', 'list-heads', file])).split('\n').sort()
            if (!same(heads, snapshot.refs.slice().sort())) throw new Error('Git refs changed during backup. Retry the operation.')
            for await (const data of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
                hash.update(data)
                await tx.query('INSERT INTO ' + chunks + ' VALUES ($1, $2)', [parts++, data])
            }
        })
    await tx.query(
        'INSERT INTO ' +
            state +
            ' VALUES(1,$1,$2,$3) ON CONFLICT (id) DO UPDATE SET snapshot=excluded.snapshot,digest=excluded.digest,parts=excluded.parts',
        [JSON.stringify(snapshot), hash.digest('hex'), parts]
    )
}

export async function restoreGithubRecovery(tx: Tx, dir: string, importing = false) {
    const [saved] = await tx.query('SELECT * FROM ' + state + ' WHERE id=1')
    if (!saved) {
        if (!importing) throw new Error('The PostgreSQL GitHub recovery record is missing. Restore the verified database backup.')
        return saveGithubRecovery(tx, dir)
    }
    const snapshot: Snapshot = saved.snapshot
    const local = await inventory(dir)
    if (same(local.refs, snapshot.refs) && same(local.config, snapshot.config)) return
    if (importing) throw new Error('GitHub configuration or named refs differ from the PostgreSQL migration target.')
    if (!same(local.refs, snapshot.refs)) {
        if (snapshot.refs.length)
            await scratch(async (file) => {
                const fd = await fs.open(file, 'wx', 0o600)
                const hash = createHash('sha256')
                try {
                    for (let seq = 0; seq < saved.parts; seq++) {
                        const [row] = await tx.query('SELECT content FROM ' + chunks + ' WHERE seq=$1', [seq])
                        if (!row) throw new Error('The GitHub recovery bundle is incomplete.')
                        hash.update(row.content)
                        await fd.writeFile(row.content)
                    }
                } finally {
                    await fd.close()
                }
                if (hash.digest('hex') !== saved.digest) throw new Error('GitHub recovery checksum mismatch.')
                await git(dir, ['bundle', 'verify', file])
                const heads = (await git(dir, ['bundle', 'unbundle', file])).split('\n').sort()
                if (!same(heads, snapshot.refs.slice().sort())) throw new Error('GitHub recovery refs differ from the verified snapshot.')
            })
        const wanted = new Map(
            snapshot.refs.map((item) => {
                const [sha, ref] = item.split(' ')
                return [ref, sha] as const
            })
        )
        for (const item of local.refs) {
            const [sha, ref] = item.split(' ')
            if (wanted.get(ref) === sha) continue
            if (!ref.startsWith('refs/versions/') && !ref.startsWith('refs/notes/'))
                throw new Error(
                    'A local Git ref differs from PostgreSQL. Preserve its commits and restart with an empty versions directory.'
                )
            if (!wanted.has(ref)) await git(dir, ['update-ref', '-d', ref, sha])
        }
        for (const item of snapshot.refs) {
            const [sha, ref] = item.split(' ')
            await git(dir, ['update-ref', ref, sha])
        }
    }
    for (const [i, name] of settings.entries()) {
        if (local.config[i] === snapshot.config[i]) continue
        const file = path.join(dir, '.git', name)
        if (snapshot.config[i] === null) await fs.rm(file, { force: true })
        else {
            const temp = await fs.mkdtemp(path.join(dir, '.git', 'restore-'))
            try {
                const replacement = path.join(temp, 'value')
                await fs.writeFile(replacement, snapshot.config[i]!, { mode: 0o600, flag: 'wx' })
                await fs.rename(replacement, file)
            } finally {
                await fs.rm(temp, { recursive: true, force: true })
            }
        }
    }
}
