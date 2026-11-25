// A queued turn can run on a different disk. Bind the opaque attachment handle to its originating chat.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { guardedEncryptionKeyOverwrite } from '../../scripts/setting-alias.cjs'

const prefix = 'cuttlely-attachment/'
let files

export function canCreatePredictionAttachment() {
    return Boolean(files && guardedEncryptionKeyOverwrite(process.env))
}

export function selectPredictionFiles(store) {
    files = store
}

function scopedKey({ workspace, flow, chat }) {
    if (![workspace, flow, chat].every((value) => typeof value === 'string' && value.length))
        throw new Error('Missing chat scope for attachment.')
    const secret = guardedEncryptionKeyOverwrite(process.env)
    if (!secret) throw new Error('The installation key is required for stored attachments.')
    return hkdfSync('sha256', secret, 'Cuttlely prediction attachment v1', JSON.stringify([workspace, flow, chat]), 32)
}

function validSegments(parts) {
    return (
        Array.isArray(parts) &&
        [3, 4].includes(parts.length) &&
        parts.every((v) => typeof v === 'string' && v && v !== '.' && v !== '..' && !/[/\\\x00]/.test(v))
    )
}

export function createPredictionAttachment(scope, parts) {
    if (!files || !validSegments(parts) || parts[1] !== scope.flow || (parts.length === 4 && parts[2] !== scope.chat))
        throw new Error('Invalid stored prediction attachment.')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', scopedKey(scope), iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(parts), 'utf8'), cipher.final()])
    return prefix + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

export async function withPredictionAttachments(input, handles, scope, work) {
    const unique = [...new Set(handles.filter((handle) => handle.startsWith(prefix)))]
    if (!unique.length) return work(input)
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cuttlely-attachment-'))
    try {
        let question = input
        for (const [i, handle] of unique.entries()) {
            let parts
            try {
                const token = Buffer.from(handle.slice(prefix.length), 'base64url')
                const cipher = createDecipheriv('aes-256-gcm', scopedKey(scope), token.subarray(0, 12))
                cipher.setAuthTag(token.subarray(12, 28))
                parts = JSON.parse(Buffer.concat([cipher.update(token.subarray(28)), cipher.final()]).toString('utf8'))
                if (!validSegments(parts)) throw new Error()
            } catch {
                question = question.replaceAll(handle, '[upload path refused]')
                continue
            }
            const folder = path.join(dir, 'files', String(i))
            await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 })
            const target = path.join(folder, parts.at(-1))
            await pipeline(files.stream(['blobs', ...parts]), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }))
            question = question.replaceAll(handle, target)
        }
        return await work(question, dir)
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true })
    }
}
