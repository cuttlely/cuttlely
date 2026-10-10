// Prediction uploads are kept per chat: two chats, or two turns of one chat, that send the same file name never replace each
// other's file, and deleting a chat removes only that chat's files. Runs against local storage in a temp folder.
import fs from 'fs'
import os from 'os'
import path from 'path'

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-upload-storage-'))
process.env.BLOB_STORAGE_PATH = STORAGE
process.env.STORAGE_TYPE = 'local'

import { IFileUpload, addArrayFilesToStorage, addSingleFileToStorage, chatScopedUploadName, getFileFromStorage } from 'flowise-components'
import { storeChatFolderUpload } from './predictionUploads'
import { removeChatUploads } from './removeChatUploads'

const ORG = 'org-bakery'
const FLOW = '6a1f0c2e-8b4d-4c3a-9e7f-2d5b1a0c9e84'
const CHAT_A = '0b7e4a52-3f1c-4d9e-8a26-5c1f7e9d2b40'
const CHAT_B = 'c3d9e1f0-7a2b-4e85-b6c4-9f0a1d2e3b57'

// A 1x1 PNG with a different trailing comment per caller, so the bytes tell the files apart.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag)])
const imageUpload = (name: string, tag: string): IFileUpload => ({
    type: 'file',
    name,
    mime: 'image/png',
    data: `data:image/png;base64,${png(tag).toString('base64')}`
})

const filesIn = (...parts: string[]): string[] => {
    const dir = path.join(STORAGE, ...parts)
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile()) : []
}

afterAll(() => fs.rmSync(STORAGE, { recursive: true, force: true }))

describe('prediction uploads kept per chat', () => {
    test('two chats upload the same name: both files are kept and each chat reads back its own', async () => {
        const a = imageUpload('cake.png', 'chat-a')
        const b = imageUpload('cake.png', 'chat-b')
        await storeChatFolderUpload(a, ORG, FLOW, CHAT_A, new Set())
        await storeChatFolderUpload(b, ORG, FLOW, CHAT_B, new Set())
        expect(a.type).toBe('stored-file')
        expect(filesIn(ORG, FLOW, CHAT_A)).toEqual([a.name])
        expect(filesIn(ORG, FLOW, CHAT_B)).toEqual([b.name])
        expect((await getFileFromStorage(a.name, ORG, FLOW, CHAT_A)).equals(png('chat-a'))).toBe(true)
        expect((await getFileFromStorage(b.name, ORG, FLOW, CHAT_B)).equals(png('chat-b'))).toBe(true)
        // Nothing lands in the shared chatflow folder.
        expect(filesIn(ORG, FLOW)).toEqual([])
    })

    test('one chat uploads the same name twice, in one request and on a later turn: every file is kept', async () => {
        const used = new Set<string>()
        const first = imageUpload('croissant.png', 'turn-1a')
        const second = imageUpload('croissant.png', 'turn-1b')
        await storeChatFolderUpload(first, ORG, FLOW, CHAT_A, used)
        await storeChatFolderUpload(second, ORG, FLOW, CHAT_A, used)
        const later = imageUpload('croissant.png', 'turn-2')
        await storeChatFolderUpload(later, ORG, FLOW, CHAT_A, new Set())
        const names = [first.name, second.name, later.name]
        expect(new Set(names).size).toBe(3)
        for (const name of names) expect(name).toMatch(/^croissant--[0-9a-f]{8}(-\d+)?\.png$/)
        expect((await getFileFromStorage(first.name, ORG, FLOW, CHAT_A)).equals(png('turn-1a'))).toBe(true)
        expect((await getFileFromStorage(second.name, ORG, FLOW, CHAT_A)).equals(png('turn-1b'))).toBe(true)
        expect((await getFileFromStorage(later.name, ORG, FLOW, CHAT_A)).equals(png('turn-2'))).toBe(true)
    })

    test('a file stored before this change, under its plain name in the chat folder, can still be read', async () => {
        await addSingleFileToStorage('image/png', png('older'), 'muffin.png', ORG, FLOW, CHAT_B)
        expect((await getFileFromStorage('muffin.png', ORG, FLOW, CHAT_B)).equals(png('older'))).toBe(true)
    })

    test('a traversal-style name stays inside the chat folder', async () => {
        const before = fs.readdirSync(STORAGE).sort()
        for (const name of ['../../escape.png', '..\\..\\escape.png', '/etc/escape.png']) {
            const upload = imageUpload(name, 'traversal')
            try {
                await storeChatFolderUpload(upload, ORG, FLOW, CHAT_A, new Set())
            } catch (e) {
                // A refused name is fine too; it must not be stored anywhere.
                continue
            }
            expect(upload.name).not.toMatch(/[\\/]/)
            expect(upload.name.startsWith('.')).toBe(false)
            expect(filesIn(ORG, FLOW, CHAT_A)).toContain(upload.name)
        }
        expect(fs.readdirSync(STORAGE).sort()).toEqual(before)
        expect(filesIn(ORG, FLOW).some((name) => name.includes('escape'))).toBe(false)
    })

    test('deleting a chat removes its folder and its chat-named documents, and keeps the other chat', async () => {
        // Documents sent as multipart files are stored in the chatflow folder under a chat-named file.
        const docA = chatScopedUploadName(CHAT_A, 'orders.csv')
        const docB = chatScopedUploadName(CHAT_B, 'orders.csv')
        await addArrayFilesToStorage('text/csv', Buffer.from('flavor,count\nlemon,4\n'), docA, [], ORG, FLOW)
        await addArrayFilesToStorage('text/csv', Buffer.from('flavor,count\nplum,9\n'), docB, [], ORG, FLOW)
        // A file another feature keeps in the chatflow folder is not a chat upload.
        await addArrayFilesToStorage('text/plain', Buffer.from('menu'), 'menu.txt', [], ORG, FLOW)
        const chatBFiles = filesIn(ORG, FLOW, CHAT_B)
        expect(filesIn(ORG, FLOW, CHAT_A).length).toBeGreaterThan(0)

        await removeChatUploads(ORG, FLOW, [CHAT_A])

        expect(fs.existsSync(path.join(STORAGE, ORG, FLOW, CHAT_A))).toBe(false)
        expect(filesIn(ORG, FLOW).sort()).toEqual([docB, 'menu.txt'].sort())
        expect(filesIn(ORG, FLOW, CHAT_B)).toEqual(chatBFiles)
    })

    test('deleting chats with no files, or with an empty id, removes nothing', async () => {
        const before = filesIn(ORG, FLOW).sort()
        await expect(removeChatUploads(ORG, FLOW, [''])).resolves.toBeUndefined()
        await removeChatUploads(ORG, FLOW, ['5e8d7c6b-0a1f-4b2c-9d3e-4f5a6b7c8d9e'])
        expect(filesIn(ORG, FLOW).sort()).toEqual(before)
    })
})
