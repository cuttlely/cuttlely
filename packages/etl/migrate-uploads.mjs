import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { uploadsRoot, pipelineDirName } from './paths.mjs'
import { createHash } from 'node:crypto'

function walk(root, skipIrregular = false) {
    const found = []
    function visit(relative) {
        const file = path.join(root, ...relative)
        const stat = fs.lstatSync(file, { throwIfNoEntry: false })
        if (!stat && !relative.length) return
        if (skipIrregular && !stat?.isDirectory() && !stat?.isFile()) return
        if (!stat || stat.isSymbolicLink()) throw new Error('Resolve linked or missing upload paths before migrating.')
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(file).sort()) visit([...relative, name])
        } else if (stat.isFile() && relative.length) found.push({ relative, bytes: stat.size })
        else throw new Error('Resolve the non-regular upload path before migrating.')
    }
    visit([])
    return found
}

export function uploadEntries(roots) {
    const etl = walk(uploadsRoot(), true).map((entry) => ({ ...entry, root: 'etlUploads' }))
    if (!roots) return etl
    const nested = path.resolve(roots.uploads) === path.resolve(roots.blobs, 'uploads')
    return [
        ...etl,
        ...walk(roots.blobs)
            .filter((entry) => !nested || entry.relative[0] !== 'uploads')
            .map((entry) => ({ ...entry, root: 'blobs' })),
        ...walk(roots.uploads).map((entry) => ({ ...entry, root: 'uploads' }))
    ]
}

function stream(roots, entry) {
    const root = entry.root === 'etlUploads' ? uploadsRoot() : roots[entry.root]
    if (!root || entry.relative.some((part) => !part || part === '.' || part === '..' || /[\\/\0]/.test(part)))
        throw new Error('Invalid upload inventory entry.')
    const location = path.join(root, ...entry.relative)
    if (fs.realpathSync(location) !== path.join(fs.realpathSync(root), ...entry.relative))
        throw new Error('The upload path changed during migration.')
    return fs.createReadStream(location, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK })
}

async function digest(roots, entry) {
    const hash = createHash('sha256')
    for await (const block of stream(roots, entry)) hash.update(block)
    return hash.digest('hex')
}

export async function inventoryUploads(source, roots) {
    const entries = uploadEntries(roots)
    if (!entries.length) return []
    const orgs = new Set(
        entries.some((entry) => entry.root === 'blobs')
            ? (await source.query('SELECT id FROM public.organization')).map((row) => row.id)
            : []
    )
    const owners = new Set()
    const live = path.join(uploadsRoot(), '..', 'etl.sqlite')
    const original = fs.existsSync(live) ? live : live + '.migrated'
    if (fs.existsSync(original) && entries.some((entry) => entry.root === 'etlUploads')) {
        const db = new DatabaseSync(original, { readOnly: true })
        try {
            for (const row of db.prepare('SELECT id,workspace_id FROM pipelines WHERE workspace_id IS NOT NULL').all()) {
                owners.add(JSON.stringify([pipelineDirName(row.workspace_id), pipelineDirName(row.id)]))
            }
        } finally {
            db.close()
        }
    }
    const seen = new Set()
    for (const entry of entries) {
        const [first, second] = entry.relative
        if (entry.root === 'etlUploads') {
            if (entry.relative.length !== 4 || !owners.has(JSON.stringify([first, second])) || !/^[a-f0-9-]{36}$/.test(entry.relative[2]))
                continue
            entry.key = ['etlUploads', ...entry.relative]
            entry.originalPath = path.resolve(uploadsRoot(), ...entry.relative)
            entry.mtimeMs = Math.floor(fs.statSync(entry.originalPath).mtimeMs)
        } else if (entry.root === 'uploads') {
            if (entry.relative.length !== 1 || !/^[a-f0-9]{32}$/.test(first)) throw new Error('An upload has no recognized legacy handle.')
            entry.key = ['uploads', first]
        } else if (orgs.has(first) && entry.relative.length >= 2) {
            entry.key = ['blobs', ...entry.relative]
        } else {
            // Old files predate organization directories. Resolve ownership from the application, never from the next reader.
            const document = first === 'docustore'
            const id = document ? second : first
            const table = document ? 'document_store' : 'chat_flow'
            const [row] = await source.query(
                'SELECT w."organizationId" AS org FROM public.' +
                    table +
                    ' f JOIN public.workspace w ON w.id=f."workspaceId" WHERE f.id::text=$1',
                [id]
            )
            if (!row?.org || !orgs.has(row.org)) throw new Error('Resolve the owner of a legacy upload before migrating.')
            entry.key = ['blobs', row.org, ...entry.relative]
        }
        const key = JSON.stringify(entry.key)
        if (seen.has(key)) throw new Error('Two local files resolve to the same PostgreSQL upload.')
        seen.add(key)
        entry.sha256 = await digest(roots, entry)
    }
    return entries.filter((entry) => entry.key)
}

// ETL source uploads may be supplied again. Other attachments must match the verified inventory.
export function matchingDurableUploads(actual, expected = []) {
    const durable = (entries) => entries.filter((entry) => entry.root !== 'etlUploads').map(({ key, sha256 }) => [key, sha256])
    return JSON.stringify(durable(actual)) === JSON.stringify(durable(expected))
}

export async function copyUploads(store, roots, entries) {
    for (const entry of entries) await store.put(entry.key, stream(roots, entry), entry.sha256)
    for (const root of ['blobs', 'uploads', 'etlUploads']) {
        if ((await store.list([root])).length !== entries.filter((entry) => entry.root === root).length)
            throw new Error('The PostgreSQL destination contains additional files.')
    }
}
