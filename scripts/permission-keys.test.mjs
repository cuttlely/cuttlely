import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { documentedPermissionKeys, permissionKeyDiff, permissionKeys, readGuideKeys } from './permission-keys.mjs'

describe('roles and permissions guide', () => {
    it('lists the same permission keys the server and the UI define', () => {
        const diff = permissionKeyDiff(permissionKeys(), readGuideKeys())
        assert.deepEqual(
            diff,
            { missingFromDoc: [], missingFromCode: [], duplicateDocKeys: [] },
            `permission keys differ\nonly in code: ${diff.missingFromDoc.join(', ')}\nonly in the guide: ${diff.missingFromCode.join(', ')}`
        )
    })

    it('fails when a key is added or removed on only one side', () => {
        const diff = permissionKeyDiff(['chatflows:view', 'tools:view'], ['chatflows:view', 'tools:export'])
        assert.deepEqual(diff.missingFromDoc, ['tools:view'])
        assert.deepEqual(diff.missingFromCode, ['tools:export'])
        assert.deepEqual(diff.duplicateDocKeys, [])
    })

    it('reads keys from the permission table', () => {
        const markdown = [
            '# Guide',
            '',
            'Mention `not:akey` in prose.',
            '',
            '## Permission keys',
            '',
            '| Key | Allows |',
            '| --- | --- |',
            '| `roles:manage` | Open Roles. |',
            ''
        ].join('\n')
        assert.deepEqual(documentedPermissionKeys(markdown), ['roles:manage'])
    })
})
