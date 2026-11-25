// Uploaded source files are immutable. The logical handle is scoped to the workspace that owns the pipeline.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { EtlError } from './errors.mjs'
import { pipelineDirName, uploadRefusal } from './paths.mjs'

const prefix = 'cuttlely-etl-upload/'
let files
let originalRoot
let originalPaths = new Map()

export function selectEtlUploads(store, entries = [], root) {
    files = store
    originalRoot = root
    originalPaths = new Map(entries.filter((item) => item.root === 'etlUploads').map((item) => [item.originalPath, item]))
}

export async function storeEtlUpload(readable, relative) {
    if (!files) return null
    const size = await files.put(['etlUploads', ...relative], readable)
    return { path: prefix + relative.join('/'), name: relative.at(-1), size }
}

export async function resolveEtlUpload(input, workspaceId) {
    const old = originalPaths.get(input)
    if (!old && !input.startsWith(prefix)) {
        if (files && originalRoot && workspaceId && path.isAbsolute(input)) {
            const parts = path.relative(originalRoot, input).split(path.sep)
            if (parts.length === 4 && parts[0] === pipelineDirName(workspaceId))
                throw new EtlError('bad_source', `Upload "${parts.at(-1)}" again in this pipeline and rerun it.`)
        }
        return null
    }
    const relative = old ? old.relative : input.slice(prefix.length).split('/')
    if (!files || !workspaceId || relative[0] !== pipelineDirName(workspaceId) || relative.length !== 4) throw uploadRefusal(input)
    const key = ['etlUploads', ...relative]
    const [metadata] = await files.list(key)
    if (!metadata || metadata.segments.length !== key.length) throw uploadRefusal(input)
    const rel = relative.slice(1).join('/')
    return {
        key: 'uploads/' + rel,
        rel,
        root: 'uploads',
        abs: relative.at(-1),
        size: metadata.size,
        mtimeMs: old?.mtimeMs || 0,
        storedKey: key
    }
}

export async function* readEtlUpload(file, read) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cuttlely-etl-read-'))
    try {
        const abs = path.join(dir, file.abs)
        await pipeline(files.stream(file.storedKey), fs.createWriteStream(abs, { mode: 0o600, flags: 'wx' }))
        yield* read({ ...file, abs })
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true })
    }
}
