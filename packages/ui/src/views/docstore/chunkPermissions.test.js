import fs from 'fs'
import path from 'path'
import { CHUNK_DELETE_PERMISSION, CHUNK_EDIT_PERMISSION } from './chunkPermissions'

describe('chunk delete permission', () => {
    test('matches the chunk delete route, not the loader delete route', () => {
        expect(CHUNK_DELETE_PERMISSION).toBe('documentStores:update,documentStores:delete')
        const source = fs.readFileSync(path.join(__dirname, 'ExpandedChunkDialog.jsx'), 'utf8')
        expect(source).toContain('permissionId={CHUNK_DELETE_PERMISSION}')
        expect(source).not.toContain('documentStores:delete-loader')
    })

    test('Edit Chunk and its Save button check documentStores:update', () => {
        expect(CHUNK_EDIT_PERMISSION).toBe('documentStores:update')
        const source = fs.readFileSync(path.join(__dirname, 'ExpandedChunkDialog.jsx'), 'utf8')
        expect(source).toContain('permissionId={CHUNK_EDIT_PERMISSION}')
        expect(source.match(/permissionId=\{CHUNK_EDIT_PERMISSION\}/g)).toHaveLength(2)
        expect(source).not.toContain('documentStores:preview-process')
    })
})
