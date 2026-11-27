// An upgrade snapshot of local runtime prompts. Never replace an operator's existing file.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { hermesHome } from '../harness/paths.mjs'

function conflict(message) {
    throw Object.assign(new Error(message), { status: 409 })
}

export function isProfilePrompt(name) {
    return name === 'SOUL.md' || /^profiles\/[A-Za-z0-9_-]+\/SOUL\.md$/.test(name)
}

function snapshotPath(name, allowed, create = false) {
    if (!allowed(name)) conflict('Invalid profile prompt in storage inventory.')
    const parts = name.split('/')
    let dir = hermesHome()
    for (const part of ['', ...parts.slice(0, -1)]) {
        dir = path.join(dir, part)
        if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        if (!fs.lstatSync(dir).isDirectory()) conflict('Resolve the linked runtime directory before restoring profile prompts.')
    }
    return path.join(dir, parts.at(-1))
}

export async function* readSnapshotSource(name, allowed) {
    const handle = await fs.promises.open(
        snapshotPath(name, allowed),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
    try {
        if (!(await handle.stat()).isFile()) conflict('Resolve the non-regular profile prompt before upgrading: ' + name)
        yield* handle.createReadStream({ autoClose: false })
    } finally {
        await handle.close()
    }
}

export async function fingerprint(name, allowed) {
    const hash = createHash('sha256')
    for await (const chunk of readSnapshotSource(name, allowed)) hash.update(chunk)
    return hash.digest('hex')
}

export async function inventoryPrompts(prompts) {
    const result = []
    for (const { name, bytes } of prompts) result.push({ name, bytes, sha256: await fingerprint(name, isProfilePrompt) })
    return result
}

const key = (name) => ['runtime-prompts', ...name.split('/')]

export async function copyPrompts(files, entries) {
    for (const { name, sha256 } of entries) await files.put(key(name), readSnapshotSource(name, isProfilePrompt), sha256)
}

export async function restorePrompts(files, entries, generation) {
    return restoreSnapshot(entries, generation, 'prompts', isProfilePrompt, ({ name }) => files.stream(key(name)))
}

export async function restoreSnapshot(entries, generation, kind, allowed, read) {
    if (!entries?.length) return
    if (!/^[0-9a-f-]{36}$/.test(generation)) conflict('Invalid profile prompt backup reference.')
    const home = hermesHome()
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(home).isDirectory()) conflict('Restore profile prompts into a regular runtime directory.')
    // Seed each disk once. Later edits and intentional deletions on that disk belong to the operator.
    const marker = path.join(home, '.cuttlely-restored-' + kind + '-' + generation)
    const existingMarker = fs.lstatSync(marker, { throwIfNoEntry: false })
    if (existingMarker?.isDirectory()) return
    if (existingMarker) conflict('Resolve the conflicting profile prompt restore marker.')
    for (const entry of entries) {
        const { name, sha256 } = entry
        const file = snapshotPath(name, allowed, true)
        if (entry.directory) {
            fs.mkdirSync(file, { recursive: true, mode: 0o700 })
            if (!fs.lstatSync(file).isDirectory()) conflict('Resolve the conflicting runtime directory: ' + name)
            continue
        }
        const existing = fs.lstatSync(file, { throwIfNoEntry: false })
        if (existing) {
            if (existing.isFile() && (await fingerprint(name, allowed)) === sha256) continue
            conflict('The existing ' + name + ' differs from the upgrade backup. Preserve it before restoring on this host.')
        }
        const temp = fs.mkdtempSync(path.join(path.dirname(file), '.restore-prompt-'))
        const staged = path.join(temp, 'SOUL.md')
        try {
            const hash = createHash('sha256')
            const handle = await fs.promises.open(staged, 'wx', entry.executable ? 0o700 : 0o600)
            try {
                for await (const part of read(entry)) {
                    await handle.writeFile(part)
                    hash.update(part)
                }
                await handle.sync()
            } finally {
                await handle.close()
            }
            if (hash.digest('hex') !== sha256) conflict('The saved profile prompt failed verification: ' + name)
            try {
                fs.linkSync(staged, file)
            } catch (error) {
                if (error.code !== 'EEXIST' || (await fingerprint(name, allowed)) !== sha256) throw error
            }
        } finally {
            fs.rmSync(temp, { recursive: true, force: true })
        }
    }
    fs.mkdirSync(marker, { recursive: true, mode: 0o700 })
}
