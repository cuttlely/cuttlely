// A queued turn can run on a different disk. Bind the opaque attachment handle to its originating chat.
import { createRequire } from 'node:module'
import { createHash, createHmac, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { guardedEncryptionKeyOverwrite } from '../../scripts/setting-alias.cjs'

const requireComponents = createRequire(new URL('../server/package.json', import.meta.url))
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

// The original attachment path/handle stays available to released callers. Managed tools
// consume this additional opaque grant only when prediction admission supplied a specific actor.
export function managedUploadActor(caller) {
    if (caller?.via === 'session' && typeof caller.tryOwner === 'string' && /^user:[^\s]{1,160}$/.test(caller.tryOwner))
        return caller.tryOwner
    if (caller?.via === 'api_key' && typeof caller.apiKeyId === 'string' && /^[^\s]{1,160}$/.test(caller.apiKeyId))
        return 'api:' + caller.apiKeyId
    return null
}
async function receiptCipher(scope, nonce, encrypt) {
    const actor = managedUploadActor(scope.caller)
    if (!actor || ![scope.workspace, scope.flow, scope.chat].every((v) => typeof v === 'string' && v.length > 0)) return null
    const { getManagedUploadKey } = requireComponents('@cuttlely/components')
    const key = await getManagedUploadKey()
    const cipher = (encrypt ? createCipheriv : createDecipheriv)('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(JSON.stringify([scope.workspace, scope.flow, scope.chat, actor])))
    return cipher
}
export async function issueManagedUpload(scope, parts, digest) {
    if (
        !validSegments(parts) ||
        parts[1] !== scope.flow ||
        (parts.length === 4 && parts[2] !== scope.chat) ||
        !/^[a-f0-9]{64}$/.test(digest)
    )
        return ''
    const nonce = randomBytes(12),
        cipher = await receiptCipher(scope, nonce, true)
    if (!cipher) return ''
    const data = Buffer.concat([cipher.update(JSON.stringify({ parts, digest }), 'utf8'), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url')
}
async function* openLocalBlob(root, parts) {
    // Relative opens against descriptors pin every directory. A rename, link or prefix
    // replacement after open cannot redirect a later segment to a different directory.
    let current = await fs.promises.open(root, fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
        for (const [i, part] of parts.entries()) {
            const flags =
                fs.constants.O_NOFOLLOW |
                fs.constants.O_NONBLOCK |
                (i < parts.length - 1 ? fs.constants.O_DIRECTORY : fs.constants.O_RDONLY)
            const child = await fs.promises.open('/proc/self/fd/' + current.fd + '/' + part, flags)
            try {
                await current.close()
            } catch (error) {
                await child.close()
                throw error
            }
            current = child
        }
        if (!(await current.stat()).isFile()) throw Error('A regular stored upload is required.')
        yield* current.createReadStream({ autoClose: false })
    } finally {
        await current.close()
    }
}
export async function readManagedUpload(token, scope, localRoot, maximum) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 8192 || !/^[a-zA-Z0-9_-]+$/.test(token)) return null
    const bytes = Buffer.from(token, 'base64url')
    const cipher = await receiptCipher(scope, bytes.subarray(0, 12), false)
    if (!cipher) return null
    let data
    try {
        cipher.setAuthTag(bytes.subarray(12, 28))
        data = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'))
    } catch {
        return null
    }
    if (!validSegments(data.parts) || data.parts[1] !== scope.flow || (data.parts.length === 4 && data.parts[2] !== scope.chat)) return null
    if (!files && !localRoot) return null
    const stream = files ? files.stream(['blobs', ...data.parts]) : openLocalBlob(localRoot, data.parts)
    let size = 0
    const chunks = []
    for await (const chunk of stream) {
        size += chunk.length
        if (size > maximum) throw Error('Workspace upload quota exceeded.')
        chunks.push(chunk)
    }
    const body = Buffer.concat(chunks, size)
    return createHash('sha256').update(body).digest('hex') === data.digest ? { body, name: data.parts.at(-1) } : null
}

// A receipt identifies the admitted owner without exposing the user/key identifier to a model or a report.
export async function managedFileOwnerTag(caller, workspace, chat) {
    const actor = managedUploadActor(caller)
    if (!actor || !workspace || !chat) return null
    const { getManagedUploadKey } = requireComponents('@cuttlely/components')
    return createHmac('sha256', await getManagedUploadKey())
        .update(JSON.stringify(['file-owner-v1', workspace, chat, actor]))
        .digest('base64url')
}
