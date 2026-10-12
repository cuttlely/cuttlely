import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveUiBuild } from './uiBuild'

function writeIndex(directory: string, body: string, mtimeMs: number) {
    fs.mkdirSync(directory, { recursive: true })
    const indexHtml = path.join(directory, 'index.html')
    fs.writeFileSync(indexHtml, body)
    const when = new Date(mtimeMs)
    fs.utimesSync(indexHtml, when, when)
}

describe('resolveUiBuild', () => {
    let root: string
    let startDir: string

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-ui-build-'))
        startDir = path.join(root, 'packages', 'server', 'dist', 'utils')
        fs.mkdirSync(startDir, { recursive: true })
    })

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true })
    })

    it('returns null when no build exists', () => {
        expect(resolveUiBuild('', startDir)).toBeNull()
    })

    it('uses the copy next to the compiled server', () => {
        const copy = path.join(root, 'packages', 'server', 'dist', 'ui')
        writeIndex(copy, 'copy', 2_000)
        const found = resolveUiBuild('', startDir)
        expect(found?.directory).toBe(path.resolve(copy))
        expect(fs.readFileSync(found!.indexHtml, 'utf8')).toBe('copy')
    })

    it('uses the repo build when that index is newer than the copy', () => {
        writeIndex(path.join(root, 'packages', 'server', 'dist', 'ui'), 'copy', 1_000)
        const repo = path.join(root, 'packages', 'ui', 'build')
        writeIndex(repo, 'repo', 5_000)
        const found = resolveUiBuild('', startDir)
        expect(found?.directory).toBe(path.resolve(repo))
        expect(fs.readFileSync(found!.indexHtml, 'utf8')).toBe('repo')
    })

    it('keeps the copy when it is newer than the repo build', () => {
        const copy = path.join(root, 'packages', 'server', 'dist', 'ui')
        writeIndex(copy, 'copy', 9_000)
        writeIndex(path.join(root, 'packages', 'ui', 'build'), 'repo', 1_000)
        expect(resolveUiBuild('', startDir)?.directory).toBe(path.resolve(copy))
    })

    it('uses a linked UI package when no copy or repo build exists', () => {
        const linked = path.join(root, 'linked-ui')
        writeIndex(path.join(linked, 'build'), 'linked', 3_000)
        const found = resolveUiBuild(linked, startDir)
        expect(found?.directory).toBe(path.resolve(linked, 'build'))
    })
})
