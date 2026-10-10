// A FILE-STORAGE:: value names a file inside the current flow's storage folder. Whatever a request puts there, a
// name that climbs out (../x), is absolute (/etc/passwd) or holds a separator never reaches a read (API-1 follow-up F6).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { LocalStorageProvider } from './LocalStorageProvider'
import { S3StorageProvider } from './S3StorageProvider'

const ORG = 'org-1'
const FLOW = '5f2b8c1e-3a4d-4e6f-9a7b-1c2d3e4f5a6b'
const REFUSED = /Invalid or unsafe fileName detected|Invalid filename after sanitization/

// The names a loader reads from a FILE-STORAGE:: value, the same way the Csv, Docx and other loaders do.
const namesIn = (value: string): string[] => {
    const fileName = value.replace('FILE-STORAGE::', '')
    return fileName.startsWith('[') && fileName.endsWith(']') ? JSON.parse(fileName) : [fileName]
}

// Names that climb out or are absolute: refused by the traversal check itself.
const CLIMBING = ['FILE-STORAGE::["../x"]', 'FILE-STORAGE::["../../secret.txt"]', 'FILE-STORAGE::/etc/passwd']
// Names with a separator: never read from a sub-folder or a parent; at most the flattened name inside the flow folder.
const SEPARATED = ['FILE-STORAGE::["a/b.txt"]', 'FILE-STORAGE::["a\\\\b.txt"]']

let root: string
const saved = { ...process.env }

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-file-storage-'))
    process.env.BLOB_STORAGE_PATH = path.join(root, 'storage')
    fs.mkdirSync(path.join(root, 'storage', ORG, FLOW), { recursive: true })
    fs.writeFileSync(path.join(root, 'storage', ORG, FLOW, 'ok.txt'), 'inside')
    // Files a climbing name would reach.
    fs.writeFileSync(path.join(root, 'storage', ORG, 'x'), 'one level up')
    fs.writeFileSync(path.join(root, 'secret.txt'), 'outside storage')
    delete process.env.PATH_TRAVERSAL_SAFETY
})

afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(root, { recursive: true, force: true })
})

describe('local storage', () => {
    test('a plain name inside the flow folder is read', async () => {
        const provider = new LocalStorageProvider()
        const [name] = namesIn('FILE-STORAGE::["ok.txt"]')
        expect((await provider.getFileFromStorage(name, ORG, FLOW)).toString()).toBe('inside')
    })

    test.each(CLIMBING)('%s is refused', async (value) => {
        const provider = new LocalStorageProvider()
        for (const name of namesIn(value)) await expect(provider.getFileFromStorage(name, ORG, FLOW)).rejects.toThrow(REFUSED)
    })

    test.each(SEPARATED)('%s never reads the sub-folder or parent file', async (value) => {
        fs.mkdirSync(path.join(root, 'storage', ORG, FLOW, 'a'), { recursive: true })
        fs.writeFileSync(path.join(root, 'storage', ORG, FLOW, 'a', 'b.txt'), 'sub-folder')
        fs.writeFileSync(path.join(root, 'storage', ORG, 'b.txt'), 'parent')
        const provider = new LocalStorageProvider()
        for (const name of namesIn(value)) await expect(provider.getFileFromStorage(name, ORG, FLOW)).rejects.toThrow()
    })
})

describe('S3 storage names', () => {
    const s3 = () => {
        process.env.S3_STORAGE_BUCKET_NAME = 'cuttlely-test'
        process.env.S3_STORAGE_REGION = 'us-east-1'
        process.env.S3_STORAGE_ACCESS_KEY_ID = 'test'
        process.env.S3_STORAGE_SECRET_ACCESS_KEY = 'test'
        const provider = new S3StorageProvider()
        const send = jest.spyOn((provider as any).s3Client, 'send').mockImplementation(async () => {
            throw new Error('no network in tests')
        })
        return { provider, send }
    }

    test.each(CLIMBING)('%s is refused before any request is made', async (value) => {
        const { provider, send } = s3()
        for (const name of namesIn(value)) await expect(provider.getFileFromStorage(name, ORG, FLOW)).rejects.toThrow(REFUSED)
        expect(send).not.toHaveBeenCalled()
    })

    test.each(SEPARATED)('%s asks only for a flat name in the flow folder', async (value) => {
        const { provider, send } = s3()
        for (const name of namesIn(value)) await expect(provider.getFileFromStorage(name, ORG, FLOW)).rejects.toThrow()
        // The key is the flow folder (with or without the org, the legacy fallback) and one flat file name.
        expect(send).toHaveBeenCalled()
        for (const call of send.mock.calls as any[]) {
            expect(String(call[0]?.input?.Key)).toMatch(new RegExp(`^(${ORG}/)?${FLOW}/[^/\\\\]+$`))
        }
    })
})
