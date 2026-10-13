import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    documentedPermissionKeys,
    permissionKeyDiff,
    permissionKeys,
    permissionLiteralProblems,
    readGuideKeys,
    readPermissionLiteralProblems
} from './permission-keys.mjs'
import { documentedRouteChecks, readGuideRouteMismatches, routeCheckMismatches } from './permission-routes.mjs'

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

    it('fails when a listed route does not declare that permission', () => {
        const problems = routeCheckMismatches(
            [{ key: 'chatflows:view', method: 'GET', path: '/api/v1/tools' }],
            [{ method: 'GET', path: '/api/v1/tools', keys: ['tools:view'] }]
        )
        assert.equal(problems.length, 1)
        assert.match(problems[0], /chatflows:view: GET \/api\/v1\/tools checks tools:view/)
    })

    it('checks every API route named in the permission table', () => {
        const documented = documentedRouteChecks(
            ['## Permission keys', '', '| `tools:view` | Open tools. | `/tools` | `GET /api/v1/tools` |', ''].join('\n')
        )
        assert.deepEqual(documented, [{ key: 'tools:view', method: 'GET', path: '/api/v1/tools' }])
        const problems = readGuideRouteMismatches()
        assert.deepEqual(problems, [], problems.join('\n'))
    })

    it('fails when a permission literal is not in the catalog', () => {
        const catalog = new Set(['chatflows:create', 'agentflows:create'])
        const prefixes = new Set(['chatflows', 'agentflows'])
        const dotted = permissionLiteralProblems("hasPermission('chatflows:create,agentflows.create')", {
            catalog,
            outside: [],
            prefixes
        })
        assert.equal(dotted.length, 1)
        assert.match(dotted[0], /agentflows\.create uses a dot/)
        const unknown = permissionLiteralProblems("requirePermission('nope:view')", { catalog, outside: [], prefixes })
        assert.deepEqual(unknown, ['nope:view is not in the permission catalog'])
        const known = permissionLiteralProblems("permission={'agentflows:create'}", { catalog, outside: [], prefixes })
        assert.deepEqual(known, [])
        const live = readPermissionLiteralProblems()
        assert.deepEqual(live, [], live.join('\n'))
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
