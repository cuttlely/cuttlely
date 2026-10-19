import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkArchitectureMap, loadBoundaryMap, trackedFiles, winningSubsystem } from './architecture-map.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('architecture map', () => {
    it('matches every glob to a tracked file and leaves no core file unassigned', () => {
        const errors = checkArchitectureMap(ROOT)
        assert.deepEqual(errors, [], errors.slice(0, 20).join('\n'))
    })

    it('keeps the known seams on the subsystem the map names', () => {
        const map = loadBoundaryMap(ROOT)
        const files = new Set(trackedFiles(ROOT))
        const expectSubsystem = {
            'packages/chat-widget/package.json': 'Chat widget',
            'packages/cli/package.json': 'CLI',
            'packages/harness/client.mjs': 'Harnesses and the Analyst',
            'harness/client.mjs': 'Harnesses and the Analyst',
            'packages/etl/runner.mjs': 'Knowledge pipelines',
            'etl/runner.mjs': 'Knowledge pipelines',
            'packages/server/src/identity/index.ts': 'Identity and RBAC',
            'packages/server/src/settings/registry.ts': 'Admin panel and server settings',
            'scripts/verify.mjs': 'core-shared',
            'ARCHITECTURE.md': 'core-shared',
            'architecture/boundaries.json': 'core-shared',
            '.gitattributes': 'core-shared'
        }
        for (const [file, name] of Object.entries(expectSubsystem)) {
            assert.equal(files.has(file), true, file)
            const win = winningSubsystem(file, map.subsystems)
            assert.equal(win?.tie, false, file)
            assert.equal(win?.name, name, file)
        }
        const runtime = winningSubsystem('hermes/UPSTREAM_COMMIT', map.subsystems)
        assert.equal(runtime?.name, 'Agent runtime')
        assert.equal(
            map.subsystems.some((subsystem) => subsystem.name === 'core-shared'),
            true
        )
    })
})
