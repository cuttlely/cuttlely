import fs from 'fs'
import path from 'path'
import { CHUNK_DELETE_PERMISSION } from './chunkPermissions'

describe('chunk delete permission', () => {
    test('matches the chunk delete route, not the loader delete route', () => {
        expect(CHUNK_DELETE_PERMISSION).toBe('documentStores:update,documentStores:delete')
        const source = fs.readFileSync(path.join(__dirname, 'ExpandedChunkDialog.jsx'), 'utf8')
        expect(source).toContain('permissionId={CHUNK_DELETE_PERMISSION}')
        expect(source).not.toContain('documentStores:delete-loader')
    })
})
